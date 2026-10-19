import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeTraeOwnDocument, type TraeCredential } from '../../../src/providers/trae/auth.ts'
import { saveTraeCatalogCache } from '../../../src/providers/trae/catalog-cache.ts'
import type { TraeModelInfo } from '../../../src/providers/trae/catalog.ts'
import { createTraeProviders } from '../../../src/providers/trae/index.ts'
import { FakeScheduler, makeFakeDeps, makeTempDir, type FakeDepsBundle } from './helpers.ts'

interface Setup {
  bundle: FakeDepsBundle
  home: string
  runtimes: ReturnType<typeof createTraeProviders>
}

const cleanups: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface SetupOptions {
  seedCredential?: TraeCredential | false
  catalogCache?: readonly TraeModelInfo[]
  fetchImpl?: (input: string | URL | Request) => Promise<Response>
}

function storedCredential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    accessToken: 'vault-access-token',
    refreshToken: 'vault-refresh-token',
    userId: 'user-1',
    accountName: '测试账号',
    host: 'https://api.trae.cn',
    userRegion: 'CN',
    expiresAtMs: Date.now() + 3_600_000,
    refreshExpiresAtMs: Date.now() + 86_400_000,
    edition: 'cn',
    source: 'dsh',
    ...overrides,
  }
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const home = await makeTempDir('trae-runtime-')
  cleanups.push(home)
  // Keep discovery away from any real Trae installation on this machine.
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  // Any accidental network call fails fast; the runtime must degrade, not throw.
  vi.stubGlobal('fetch', options.fetchImpl ?? (async () => {
    throw new Error('offline in tests')
  }))
  const bundle = makeFakeDeps({ home })
  if (options.catalogCache !== undefined) {
    await saveTraeCatalogCache(bundle.paths.stateDir, 'cn', options.catalogCache, Date.now())
  }
  if (options.seedCredential !== undefined && options.seedCredential !== false) {
    bundle.vault.seed('trae-cn', serializeTraeOwnDocument([options.seedCredential]))
  }
  const runtimes = createTraeProviders(bundle.deps)
  const cn = runtimes[0]!
  await cn.init()
  return { bundle, home, runtimes }
}

interface ServedAdapter {
  listModels(provider: string): Promise<readonly { id: string }[]>
}

/**
 * Model ids the adapter actually serves. This is the same seam DSH reads, so
 * comparing it with `status().catalog.models` proves the settings page and the
 * picker/shim agree.
 */
async function servedIds(bundle: FakeDepsBundle, provider = 'trae', index = 0): Promise<string[]> {
  const adapter = bundle.llm.adapters[index] as ServedAdapter | undefined
  if (adapter === undefined) throw new Error('adapter was not registered')
  const models = await adapter.listModels(provider)
  return models.map(model => model.id)
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function remoteModelsDocument(model: string): unknown {
  return {
    code: 0,
    data: {
      list: [{
        function: 'solo_agent',
        models: [{ name: model, display_name: model.toUpperCase(), context_window_tokens: { dev: 200_000 } }],
      }],
    },
  }
}

function wireModelsDocument(model: string): unknown {
  return {
    config_info_list: [{
      config_name: model,
      display_config: { display_name: model.toUpperCase() },
      model_detail_list: [{ prompt_max_tokens: 200_000 }],
    }],
  }
}

/** Serve a live directory for `model`, and optionally the CN usage endpoints. */
function liveFetch(model: () => string | undefined, withUsage = false): (input: string | URL | Request) => Promise<Response> {
  return async (input) => {
    const url = String(input)
    const current = model()
    if (url.includes('/models?functions=')) {
      if (current === undefined) throw new Error('offline in tests')
      return jsonResponse(remoteModelsDocument(current))
    }
    if (url.includes('/api/ide/v1/get_detail_param')) {
      if (current === undefined) throw new Error('offline in tests')
      return jsonResponse(wireModelsDocument(current))
    }
    if (withUsage && url.includes('/trae/api/v2/pay/web_user_ent_usage')) {
      return jsonResponse({
        is_credits_billing: true,
        usage_summary: { total_amount: 100, consumed_amount: 25, consumption_ratio: 0.25 },
        user_entitlement_pack_list: [],
      })
    }
    if (withUsage && url.includes('/trae/api/v2/ug/checkin_credits/status')) {
      return jsonResponse({ checked_in: true, did_checked_in: true, credits: 10, enable: true })
    }
    throw new Error('offline in tests')
  }
}

/** The five-minute background observer registered by init(). */
function usageTimer(bundle: FakeDepsBundle): () => Promise<void> | void {
  const call = (bundle.scheduler as FakeScheduler).calls.find(entry => entry.name === 'trae:usage')
  if (call === undefined) throw new Error('the Trae usage timer was not registered')
  return call.run
}

describe('createTraeProviders', () => {
  it('returns one runtime per region with the hub provider ids', () => {
    const bundle = makeFakeDeps({ home: '/tmp/does-not-matter' })
    const runtimes = createTraeProviders(bundle.deps)
    expect(runtimes.map(runtime => runtime.descriptor)).toEqual([
      { id: 'trae', family: 'trae', region: 'cn', label: { zh: 'Trae', en: 'Trae' } },
      { id: 'trae-global', family: 'trae', region: 'global', label: { zh: 'Trae 国际版', en: 'Trae Global' } },
    ])
  })
})

describe('Trae runtime while signed out', () => {
  it('initializes without a credential, registers the adapter and reports needs-credential', async () => {
    const { bundle, runtimes } = await setup()
    const runtime = runtimes[0]!
    expect(bundle.llm.registered).toEqual([['trae']])
    expect(bundle.llm.replacements[0]).toEqual(['trae'])
    expect(bundle.llm.directory).toEqual([{ provider: 'trae', settingsNs: 'dsh-connect-hub' }])
    const status = runtime.status()
    expect(status.state).toBe('needs-credential')
    expect(status.catalog.source).toBe('builtin')
    // No account means no served fallback models; the picker must not offer a
    // call that is guaranteed to 401.
    expect(status.catalog.models).toEqual([])
    expect(status.transfer).toEqual({ supported: true })
    expect(status.warnings.some(warning => warning.code === 'no_account')).toBe(true)
    // The loopback shim is listening before any chat is possible.
    expect(bundle.llm.replacements.length).toBeGreaterThanOrEqual(1)
    await runtime.dispose()
    expect(bundle.llm.disposed).toBe(true)
    // A second dispose (double teardown / host restart race) must be a no-op.
    await expect(runtime.dispose()).resolves.toBeUndefined()
  })

  it('is idempotent on init and keeps the second runtime independent', async () => {
    const { bundle, runtimes } = await setup()
    await runtimes[0]!.init()
    expect(bundle.llm.registered.filter(providers => providers[0] === 'trae')).toHaveLength(1)
    await runtimes[1]!.init()
    expect(runtimes[1]!.status().state).toBe('needs-credential')
    expect(bundle.llm.registered.filter(providers => providers[0] === 'trae-global')).toHaveLength(1)
    await Promise.all(runtimes.map(runtime => runtime.dispose()))
  })

  it('answers unknown actions with an empty result instead of throwing', async () => {
    const { runtimes } = await setup()
    const runtime = runtimes[0]!
    await expect(runtime.action({ type: 'save-secret', provider: 'trae', secret: 'ignored' })).resolves.toEqual({})
    await expect(runtime.action({ type: 'clear-secret', provider: 'trae' })).resolves.toEqual({})
    await runtime.dispose()
  })

  it('persists the check-in schedule and keeps the timer registration in sync', async () => {
    const { bundle, runtimes } = await setup()
    const runtime = runtimes[0]!
    const scheduler = bundle.scheduler as FakeScheduler
    expect(scheduler.calls.some(call => call.kind === 'atUtc8Minute' && call.name === 'trae:checkin')).toBe(true)

    await runtime.action({ type: 'set-checkin', provider: 'trae', enabled: true, minute: 600 })
    const stored = bundle.prefs.peek('provider:trae') as { checkin: { enabled: boolean; minute: number } }
    expect(stored.checkin.enabled).toBe(true)
    expect(stored.checkin.minute).toBe(600)
    expect(runtime.status().checkin).toMatchObject({ minute: 600, enabled: true })

    await runtime.action({ type: 'set-checkin', provider: 'trae', enabled: false })
    expect(runtime.status().checkin?.enabled).toBe(false)
    await runtime.dispose()
  })

  it('applies model visibility and max-context preferences through actions', async () => {
    const { bundle, runtimes } = await setup({ seedCredential: storedCredential() })
    const runtime = runtimes[0]!
    const modelId = runtime.status().catalog.models[0]!.id
    const eventsBefore = bundle.emitterEvents.length
    await runtime.action({ type: 'set-models-enabled', provider: 'trae', modelIds: [modelId], enabled: false })
    const model = runtime.status().catalog.models.find(item => item.id === modelId)
    expect(model?.enabled).toBe(false)
    expect(bundle.emitterEvents.length).toBeGreaterThan(eventsBefore)
    expect(bundle.emitterEvents).toContain('llm/adapters-updated')

    await runtime.action({ type: 'set-max-context', provider: 'trae', useMax: true })
    expect((bundle.prefs.peek('provider:trae') as { useMaxContext: boolean }).useMaxContext).toBe(true)
    await runtime.dispose()
  })

  it('gates quota-spending probes behind explicit consent', async () => {
    const { runtimes } = await setup()
    const runtime = runtimes[0]!
    await expect(runtime.action({ type: 'probe-model', provider: 'trae', modelId: 'glm-5.2' }))
      .rejects.toThrow(/授权/)
    await runtime.action({ type: 'set-probe-consent', provider: 'trae', consent: true })
    expect(runtime.status().probes?.consent).toBe(true)
    await runtime.dispose()
  })

  it('previews a transfer file without network access and without token material', async () => {
    const { runtimes } = await setup()
    const runtime = runtimes[0]!
    const file = JSON.stringify([{
      access_token: 'secret-token-value',
      uid: 'u1',
      nickname: '小明',
      domain: 'https://api.trae.cn',
    }])
    const result = await runtime.action({ type: 'transfer-preview', provider: 'trae', text: file })
    expect(result.data).toMatchObject({ rows: [{ id: 'account:0', label: '小明', region: 'cn', hasToken: true }], skipped: 0 })
    expect(JSON.stringify(result)).not.toContain('secret-token-value')
    await runtime.dispose()
  })

  it('refuses an import whose region cannot be positively identified', async () => {
    const { bundle, runtimes } = await setup()
    const runtime = runtimes[0]!
    const file = JSON.stringify([
      { access_token: 'forged-token', uid: 'u1', nickname: 'forged', domain: 'https://evil.example' },
    ])
    const result = await runtime.action({ type: 'transfer-import', provider: 'trae', text: file, accountIds: ['account:0'] })
    expect(result.data).toEqual({ imported: 0, skipped: 1 })
    expect(bundle.vault.peek('trae-cn')).toBeUndefined()
    await runtime.dispose()
  })

  it('refuses a forged HTTP refresh host on import', async () => {
    const { bundle, runtimes } = await setup()
    const runtime = runtimes[0]!
    const file = JSON.stringify([{
      access_token: 'forged-token',
      refresh_token: 'forged-refresh',
      uid: 'u1',
      domain: 'http://evil.example',
      auth_raw: { userRegion: { region: 'CN' } },
    }])
    const result = await runtime.action({ type: 'transfer-import', provider: 'trae', text: file, accountIds: ['account:0'] })
    expect(result.data).toEqual({ imported: 0, skipped: 1 })
    expect(bundle.vault.peek('trae-cn')).toBeUndefined()
    await runtime.dispose()
  })

  it('throws for a transfer export with nothing to export', async () => {
    const { runtimes } = await setup()
    await expect(runtimes[0]!.action({ type: 'transfer-export', provider: 'trae', accountIds: ['acc-1'] }))
      .rejects.toThrow(/没有可导出的账号/)
    await runtimes[0]!.dispose()
  })
})

describe('Trae runtime with a stored account', () => {
  it('reports a ready provider, masks the token, and exports only on the explicit action', async () => {
    const { runtimes } = await setup({ seedCredential: storedCredential() })
    const runtime = runtimes[0]!
    await Promise.resolve()
    const status = runtime.status()
    expect(status.state).toBe('ready')
    expect(status.accounts).toHaveLength(1)
    expect(status.accounts?.[0]).toMatchObject({ label: '测试账号', selected: true })
    expect(status.credential?.masked).toBe('****oken')
    expect(JSON.stringify(status)).not.toContain('vault-access-token')

    const exported = await runtime.action({ type: 'transfer-export', provider: 'trae', accountIds: [status.accounts![0]!.id] })
    const data = exported.data as { fileName: string; content: string }
    expect(data.fileName).toBe('trae-cn-accounts.json')
    // The explicit export action is the one place credential material leaves.
    expect(data.content).toContain('vault-access-token')
    // Status is untouched by it.
    expect(JSON.stringify(runtime.status())).not.toContain('vault-access-token')

    await runtime.action({ type: 'set-model-enabled', provider: 'trae', modelId: status.catalog.models[0]!.id, enabled: false })
    expect(runtime.status().catalog.models[0]?.enabled).toBe(false)
    await runtime.dispose()
  })

  it('keeps the fallback roster usable while a credential exists but the live fetch fails', async () => {
    const { runtimes } = await setup({ seedCredential: storedCredential() })
    const runtime = runtimes[0]!
    const status = runtime.status()
    expect(status.state).toBe('ready')
    expect(status.catalog.source).toBe('builtin')
    expect(status.catalog.models.length).toBeGreaterThan(0)
    expect(status.warnings.map(warning => warning.code)).toContain('catalog_fallback')
    await runtime.dispose()
  })

  it('rejects selecting an account that does not exist', async () => {
    const { runtimes } = await setup({ seedCredential: storedCredential() })
    await expect(runtimes[0]!.action({ type: 'select-account', provider: 'trae', accountId: 'missing' }))
      .rejects.toThrow(/账号不存在/)
    await runtimes[0]!.dispose()
  })

  it('reports a failed check-in read honestly and clears the log on request', async () => {
    const { runtimes } = await setup({ seedCredential: storedCredential() })
    const runtime = runtimes[0]!
    const accountId = runtime.status().accounts![0]!.id
    // The network is stubbed to fail, so the read fails and is reported honestly.
    await expect(runtime.action({ type: 'checkin', provider: 'trae', accountId }))
      .rejects.toThrow(/签到状态失败/)
    await runtime.action({ type: 'clear-checkin-log', provider: 'trae' })
    expect(runtime.status().checkin?.log).toEqual([])
    await runtime.dispose()
  })
})

describe('Trae catalog visibility across account transitions', () => {
  it('serves the roster immediately after refresh-account discovers a sign-in', async () => {
    const { bundle, runtimes } = await setup()
    const runtime = runtimes[0]!
    expect(runtime.status().catalog.models).toEqual([])
    expect(await servedIds(bundle)).toEqual([])

    bundle.vault.seed('trae-cn', serializeTraeOwnDocument([storedCredential()]))
    const result = await runtime.action({ type: 'refresh-account', provider: 'trae' })
    expect(result.message).toContain('已读取登录状态')

    const statusIds = runtime.status().catalog.models.map(model => model.id)
    expect(statusIds.length).toBeGreaterThan(0)
    // The settings page and the adapter/picker now expose the same roster;
    // before the fix the adapter stayed hidden until a manual catalog refresh.
    expect(await servedIds(bundle)).toEqual(statusIds)
    await runtime.dispose()
  })

  it('stops serving the catalog when the last account disappears', async () => {
    const { bundle, runtimes } = await setup({ seedCredential: storedCredential() })
    const runtime = runtimes[0]!
    expect((await servedIds(bundle)).length).toBeGreaterThan(0)

    await bundle.vault.remove('trae-cn')
    await expect(runtime.action({ type: 'refresh-account', provider: 'trae' }))
      .rejects.toMatchObject({ code: 'not_configured' })

    expect(runtime.status().catalog.models).toEqual([])
    // No signed-in account = nothing served, not the previous account's roster.
    expect(await servedIds(bundle)).toEqual([])
    await runtime.dispose()
  })

  it('drops the previous account roster when select-account switches identity', async () => {
    const cacheModel: TraeModelInfo = {
      id: 'cached-account-only',
      name: 'Cached Account Only',
      contextWindow: 200_000,
    }
    const accountA = storedCredential()
    const accountB = storedCredential({
      accessToken: 'vault-access-token-b',
      refreshToken: 'vault-refresh-token-b',
      userId: 'user-2',
      accountName: '账号二',
    })
    const { bundle, runtimes } = await setup({
      seedCredential: accountA,
      catalogCache: [cacheModel],
    })
    const runtime = runtimes[0]!
    // The cached live roster belongs to the account that fetched it.
    expect(runtime.status().catalog.models.map(model => model.id)).toContain(cacheModel.id)
    expect(await servedIds(bundle)).toContain(cacheModel.id)

    bundle.vault.seed('trae-cn', serializeTraeOwnDocument([accountA, accountB]))
    await runtime.action({ type: 'refresh-account', provider: 'trae' })
    expect(runtime.status().accounts).toHaveLength(2)
    const other = runtime.status().accounts!.find(account => !account.selected)
    expect(other).toBeDefined()

    await runtime.action({ type: 'select-account', provider: 'trae', accountId: other!.id })
    const statusIds = runtime.status().catalog.models.map(model => model.id)
    expect(statusIds).not.toContain(cacheModel.id)
    expect(await servedIds(bundle)).toEqual(statusIds)
    await runtime.dispose()
  })

  it('drops a catalog fetched for an account that changed before publish', async () => {
    const accountA = storedCredential()
    const accountB = storedCredential({
      accessToken: 'vault-access-token-b',
      refreshToken: 'vault-refresh-token-b',
      userId: 'user-2',
      accountName: '账号二',
    })
    const liveDocument = {
      code: 0,
      data: {
        list: [{
          function: 'solo_agent',
          models: [{ name: 'live-a', display_name: 'Live A', context_window_tokens: { dev: 200_000 } }],
        }],
      },
    }
    const wireDocument = {
      config_info_list: [{
        config_name: 'live-a',
        display_config: { display_name: 'Live A' },
        model_detail_list: [{ prompt_max_tokens: 200_000 }],
      }],
    }
    let remoteGate: Promise<Response> | undefined
    let releaseRemote: (response: Response) => void = () => {}
    let remoteStarted = false
    const { bundle, runtimes } = await setup({
      seedCredential: accountA,
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('/models?functions=')) {
          if (remoteGate !== undefined) {
            remoteStarted = true
            return await remoteGate
          }
          return jsonResponse(liveDocument)
        }
        if (url.includes('/api/ide/v1/get_detail_param')) return jsonResponse(wireDocument)
        throw new Error('offline in tests')
      },
    })
    const runtime = runtimes[0]!
    // Let the startup refresh settle so the test owns the next request. The
    // client captured `fetch` at construction, so the gate is switched on
    // through the same stub rather than `vi.stubGlobal`.
    await vi.waitFor(() => { expect(runtime.status().catalog.source).toBe('live') })
    remoteGate = new Promise<Response>((resolve) => { releaseRemote = resolve })

    const pending = runtime.action({ type: 'refresh-catalog', provider: 'trae' })
    await vi.waitFor(() => { expect(remoteStarted).toBe(true) })
    // The Trae app can replace its local sign-in while the directory read is
    // in flight; the guard still names A, so the publish-time store check must
    // catch B and drop the result.
    bundle.vault.seed('trae-cn', serializeTraeOwnDocument([accountB]))
    releaseRemote(jsonResponse(liveDocument))

    await expect(pending).rejects.toMatchObject({ code: 'stale_identity' })
    const status = runtime.status()
    expect(status.accounts).toHaveLength(1)
    expect(status.accounts?.[0]?.label).toBe('账号二')
    expect(status.catalog.source).toBe('builtin')
    expect(status.catalog.models.map(model => model.id)).not.toContain('live-a')
    await runtime.dispose()
  })

  it('refreshes the roster when the periodic usage refresh detects an external sign-in', async () => {
    let model = 'live-a'
    const { bundle, runtimes } = await setup({
      seedCredential: storedCredential(),
      fetchImpl: liveFetch(() => model),
    })
    const runtime = runtimes[0]!
    await vi.waitFor(() => { expect(runtime.status().catalog.source).toBe('live') })
    expect(runtime.status().catalog.models.map(entry => entry.id)).toEqual(['live-a'])
    expect(await servedIds(bundle)).toEqual(['live-a'])

    // The Trae app signs in as B without the hub seeing an action; the 5-minute
    // usage refresh is the first observer.
    model = 'live-b'
    const accountB = storedCredential({
      accessToken: 'vault-access-token-b',
      refreshToken: 'vault-refresh-token-b',
      userId: 'user-2',
      accountName: '账号二',
    })
    bundle.vault.seed('trae-cn', serializeTraeOwnDocument([accountB]))
    await usageTimer(bundle)()

    // The account-scoped roster was dropped with the identity transition: A's
    // live list is gone before any B directory read starts.
    expect(runtime.status().accounts?.map(account => account.label)).toEqual(['账号二'])
    const idsAfterTransition = runtime.status().catalog.models.map(entry => entry.id)
    expect(idsAfterTransition).not.toContain('live-a')
    expect(await servedIds(bundle)).toEqual(idsAfterTransition)

    // ...and the new account's directory is fetched immediately.
    await vi.waitFor(() => { expect(runtime.status().catalog.source).toBe('live') })
    expect(runtime.status().catalog.models.map(entry => entry.id)).toEqual(['live-b'])
    expect(await servedIds(bundle)).toEqual(['live-b'])

    // "重新读取账号" preserves the repaired roster; it never reintroduces A's.
    const result = await runtime.action({ type: 'refresh-account', provider: 'trae' })
    expect(result.message).toContain('已读取登录状态')
    const idsAfterRescan = runtime.status().catalog.models.map(entry => entry.id)
    expect(idsAfterRescan).not.toContain('live-a')
    expect(await servedIds(bundle)).toEqual(idsAfterRescan)
    await runtime.dispose()
  })

  it('stops serving models and clears credits when the periodic usage refresh detects an external sign-out', async () => {
    const { bundle, runtimes } = await setup({
      seedCredential: storedCredential(),
      fetchImpl: liveFetch(() => 'live-a', true),
    })
    const runtime = runtimes[0]!
    await vi.waitFor(() => { expect(runtime.status().catalog.source).toBe('live') })
    await vi.waitFor(() => { expect(runtime.status().credits).toBeDefined() })
    expect(runtime.status().credits?.kind).toBe('credits')
    expect((await servedIds(bundle)).length).toBeGreaterThan(0)

    // The app signs out; the usage refresh is the first observer again.
    await bundle.vault.remove('trae-cn')
    await usageTimer(bundle)()

    const status = runtime.status()
    expect(status.state).toBe('needs-credential')
    expect(status.accounts).toEqual([])
    expect(status.catalog.models).toEqual([])
    expect(status.credits).toBeUndefined()
    expect(status.warnings.map(warning => warning.code)).toContain('no_account')
    expect(await servedIds(bundle)).toEqual([])
    await runtime.dispose()
  })

  it('repairs a saved roster that predates the signed-in account on refresh-account', async () => {
    // The region cache belongs to a previous session's account; this session
    // starts signed in as B and the live fetch is offline, so the saved list
    // is served under B until a successful refresh replaces it.
    const cacheModel: TraeModelInfo = { id: 'account-a-only', name: 'Account A Only', contextWindow: 200_000 }
    let online = false
    const model = 'live-b'
    const { bundle, runtimes } = await setup({
      seedCredential: storedCredential({
        accessToken: 'vault-access-token-b',
        refreshToken: 'vault-refresh-token-b',
        userId: 'user-2',
        accountName: '账号二',
      }),
      catalogCache: [cacheModel],
      fetchImpl: async input => {
        if (!online) throw new Error('offline in tests')
        return await liveFetch(() => model)(input)
      },
    })
    const runtime = runtimes[0]!
    expect(runtime.status().catalog.source).toBe('saved')
    const savedIds = runtime.status().catalog.models.map(entry => entry.id)
    expect(savedIds).toContain(cacheModel.id)
    expect(await servedIds(bundle)).toEqual(savedIds)
    // The startup fetch fails (one retry), leaving the saved roster in place.
    await vi.waitFor(() => { expect(runtime.status().catalog.error).toBeDefined() }, { timeout: 5_000 })

    online = true
    const result = await runtime.action({ type: 'refresh-account', provider: 'trae' })
    expect(result.message).toContain('已读取登录状态')
    await vi.waitFor(() => { expect(runtime.status().catalog.source).toBe('live') })
    const ids = runtime.status().catalog.models.map(entry => entry.id)
    expect(ids).not.toContain(cacheModel.id)
    expect(ids).toEqual([model])
    expect(await servedIds(bundle)).toEqual(ids)
    await runtime.dispose()
  })
})

describe('Trae runtime credential refresh', () => {
  it('rotates an expiring access token on refresh-account and reports it', async () => {
    let exchangeCalls = 0
    const { bundle, runtimes } = await setup({
      seedCredential: storedCredential({
        accessToken: 'expired-token',
        expiresAtMs: Date.now() - 60_000,
        refreshExpiresAtMs: Date.now() + 86_400_000,
      }),
      fetchImpl: async input => {
        const url = String(input)
        if (!url.includes('/oauth/ExchangeToken')) throw new Error('offline in tests')
        exchangeCalls += 1
        return new Response(JSON.stringify({
          Result: { Token: 'rotated-zzzz', RefreshToken: 'rotated-refresh', TokenExpireAt: Date.now() + 3_600_000 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const runtime = runtimes[0]!
    const result = await runtime.action({ type: 'refresh-account', provider: 'trae' })
    expect(exchangeCalls).toBe(1)
    expect(result.message).toContain('登录令牌已自动更新')
    expect(runtime.status().credential?.masked).toBe('****zzzz')
    expect(runtime.status().state).toBe('ready')
    const stored = bundle.vault.peek('trae-cn') as { credentials: { accessToken: string; source: string }[] }
    expect(stored.credentials[0]?.accessToken).toBe('rotated-zzzz')
    expect(stored.credentials[0]?.source).toBe('dsh')
    expect(JSON.stringify(runtime.status())).not.toContain('rotated-zzzz')
    await runtime.dispose()
  })

  it('keeps a still-valid token and reports a plain account rescan', async () => {
    const { runtimes } = await setup({ seedCredential: storedCredential() })
    const runtime = runtimes[0]!
    const result = await runtime.action({ type: 'refresh-account', provider: 'trae' })
    expect(result.message).toContain('已读取登录状态')
    expect(result.data).toEqual({ accounts: 1, tokenRefreshed: false })
    await runtime.dispose()
  })
})

describe('Trae runtime in a fresh profile', () => {
  it('reports needs-credential with no app sign-in and an empty vault, without crashing', async () => {
    const { bundle, runtimes, home } = await setup()
    const runtime = runtimes[0]!
    const status = runtime.status()
    expect(status.state).toBe('needs-credential')
    expect(status.accounts).toEqual([])
    expect(status.credential).toBeUndefined()
    expect(status.catalog.models).toEqual([])
    expect(bundle.vault.peek('trae-cn')).toBeUndefined()
    // Nothing was persisted and no local file was read or created.
    expect(bundle.prefs.peek('provider:trae')).toBeUndefined()
    expect(await readdir(home)).toEqual([])
    await runtime.dispose()
  })

  it('ignores earlier plugin-owned auth copies and profile rows', async () => {
    const home = await makeTempDir('trae-fresh-')
    cleanups.push(home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline in tests')
    })
    // Plant artifacts from an earlier, unrelated plugin generation. The names
    // are assembled here so the foreign brand does not appear in this tree; the
    // point of the test is that NOTHING reads these paths.
    const oldOwnAuthName = ['.trae', 'auth.cn.json'].join('-')
    const oldSingleAuthName = ['.trae', 'auth.json'].join('-')
    const oldPluginRowId = ['dsh-connect', 'trae'].join('-')
    await writeFile(join(home, oldOwnAuthName), JSON.stringify({
      version: 2,
      credentials: [{
        accessToken: 'old-plugin-token',
        userId: 'old-user',
        host: 'https://api.trae.cn',
        userRegion: 'CN',
        expiresAtMs: Date.now() + 3_600_000,
        edition: 'cn',
        source: 'dsh',
      }],
    }))
    await writeFile(join(home, oldSingleAuthName), JSON.stringify({ version: 1, credential: { accessToken: 'legacy-single' } }))
    const profileDir = join(home, 'profiles', 'desktop')
    const { mkdir, readFile } = await import('node:fs/promises')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'cordis.patch.yml'), [
      `- id: ${oldPluginRowId}`,
      '  config:',
      '    regions:',
      '      cn:',
      '        enabledModelIds:',
      '          - glm-5.2',
      '',
    ].join('\n'))
    const bundle = makeFakeDeps({ home, profileDir })
    const runtimes = createTraeProviders(bundle.deps)
    await runtimes[0]!.init()
    const status = runtimes[0]!.status()
    expect(status.state).toBe('needs-credential')
    expect(status.accounts).toEqual([])
    expect(bundle.vault.peek('trae-cn')).toBeUndefined()
    expect(bundle.prefs.peek('provider:trae')).toBeUndefined()
    // Planted files are left untouched.
    expect(JSON.parse(await readFile(join(home, oldOwnAuthName), 'utf8'))).toMatchObject({ version: 2 })
    await runtimes[0]!.dispose()
  })
})
