import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkBuddyRuntime } from '../../../src/providers/workbuddy/runtime.ts'
import type {
  WorkBuddyCatalogFetch,
  WorkBuddyChatResult,
  WorkBuddyCheckinActivity,
  WorkBuddyCheckinClaim,
  WorkBuddyCredits,
  WorkBuddyRefreshOutcome,
  WorkBuddyUpstream,
  WorkBuddyUpstreamModel,
} from '../../../src/providers/workbuddy/upstream.ts'
import type { ProbeAttempt } from '../../../src/providers/workbuddy/probe.ts'
import type { WorkBuddyCredential, WorkBuddyCredentialSource } from '../../../src/providers/workbuddy/auth.ts'
import { AI_VARIANT, CN_VARIANT } from '../../../src/providers/workbuddy/variants.ts'
import { createTestDeps, type TestDeps } from './helpers.ts'

/**
 * Offline end-to-end coverage of one WorkBuddy route: desktop credential
 * discovery from a temporary file, catalog lifecycle, actions, the vault copy,
 * and the status document. No network, no real WorkBuddy app, no loopback
 * listener (the transport is skipped).
 */

interface FakeClient extends WorkBuddyUpstream {
  calls: {
    fetchModels: number
    fetchCredits: number
    fetchCheckin: number
    claimCheckin: number
    refreshToken: number
    probeEffort: string[]
  }
}

interface FakeClientOptions {
  models?: readonly WorkBuddyUpstreamModel[]
  modelsError?: Error
  credits?: WorkBuddyCredits
  creditsError?: Error
  refresh?: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  probe?: (modelId: string, effort: string | undefined) => ProbeAttempt
  checkin?: WorkBuddyCheckinActivity
  claim?: WorkBuddyCheckinClaim
  checkinError?: Error
}

function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const calls = {
    fetchModels: 0,
    fetchCredits: 0,
    fetchCheckin: 0,
    claimCheckin: 0,
    refreshToken: 0,
    probeEffort: [] as string[],
  }
  const client: FakeClient = {
    lastCatalog: undefined as WorkBuddyCatalogFetch | undefined,
    calls,
    async fetchModels() {
      calls.fetchModels += 1
      if (options.modelsError !== undefined) throw options.modelsError
      client.lastCatalog = { fetchedAtMs: Date.now(), source: 'workbuddy:cli' }
      return options.models ?? []
    },
    async fetchCredits() {
      calls.fetchCredits += 1
      if (options.creditsError !== undefined) throw options.creditsError
      return options.credits ?? { total: 0, accounts: [] }
    },
    async fetchCheckinStatus() {
      calls.fetchCheckin += 1
      if (options.checkinError !== undefined) throw options.checkinError
      return options.checkin
    },
    async claimDailyCheckin() {
      calls.claimCheckin += 1
      const claim = options.claim ?? { ok: false, code: -1, message: 'not used in this spec' }
      if (claim.ok && options.checkin !== undefined) {
        options.checkin.todayCheckedIn = true
        options.checkin.todayCredit = claim.credit
        options.checkin.totalCredits += claim.credit
      }
      return claim
    },
    async refreshToken(credential) {
      calls.refreshToken += 1
      return await (options.refresh?.(credential) ?? { accessToken: 'refreshed-access' })
    },
    async chatStream(): Promise<WorkBuddyChatResult> {
      return { ok: false, status: 0, kind: 'server', message: 'not used in this spec' }
    },
    async probeEffort(_credential, modelId, effort) {
      calls.probeEffort.push(`${modelId}:${effort ?? 'baseline'}`)
      return options.probe?.(modelId, effort) ?? { status: 200, streamed: true }
    },
  }
  return client
}

const MODELS: readonly WorkBuddyUpstreamModel[] = [
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    reasoning: {
      supports: true,
      onlyReasoning: true,
      supportedEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      canDisableThinking: false,
    },
    billing: { credits: 'x0.79 credits', free: false },
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: false,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false },
    billing: { credits: 'x0.00', free: true },
  },
]

const CN_DOCUMENT = (expiresAtMs: number): string =>
  JSON.stringify({
    auth: {
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      expiresAt: expiresAtMs,
      domain: 'www.codebuddy.cn',
    },
    account: { uid: 'uid-1', enterpriseId: 'ent-1', nickname: 'alice@example.com' },
  })

const AI_DOCUMENT = (expiresAtMs: number): string =>
  JSON.stringify({
    auth: {
      accessToken: 'secret-ai-access-token',
      refreshToken: 'secret-ai-refresh-token',
      expiresAt: expiresAtMs,
      domain: 'www.workbuddy.ai',
    },
    account: { uid: 'uid-9', nickname: 'Tester' },
  })

interface Harness {
  testDeps: TestDeps
  runtime: ReturnType<typeof createWorkBuddyRuntime>
  client: FakeClient
  desktopPath: string
}

const HARNESSES: Harness[] = []

/** Wait for a condition the asynchronous first catalog fetch eventually reaches. */
async function settle(predicate: () => boolean, label: string): Promise<void> {
  await vi.waitFor(() => { expect(predicate(), label).toBe(true) }, { timeout: 5_000 })
}

const live = (runtime: ReturnType<typeof createWorkBuddyRuntime>): Promise<void> =>
  settle(() => runtime.status().catalog.source === 'live', 'live catalog')

/** Wait for the background first read to settle into a credits view. */
const creditsSettled = (runtime: ReturnType<typeof createWorkBuddyRuntime>): Promise<void> =>
  settle(() => runtime.status().credits !== undefined, 'credits view')

afterEach(async () => {
  for (const harness of HARNESSES.splice(0)) {
    await harness.runtime.dispose()
    await harness.testDeps.cleanup()
  }
})

async function harness(options: {
  variant?: typeof CN_VARIANT | typeof AI_VARIANT
  document?: string
  client?: FakeClient
  credentialStore?: WorkBuddyCredentialSource
  now?: () => number
  pollMs?: number
  usagePollMs?: number
  seed?: (paths: TestDeps['paths']) => Promise<void>
} = {}): Promise<Harness> {
  const testDeps = await createTestDeps()
  await options.seed?.(testDeps.paths)
  const variant = options.variant ?? CN_VARIANT
  const desktopPath = join(testDeps.paths.home, `${variant.id}.info`)
  if (options.document !== undefined) await writeFile(desktopPath, options.document)
  const client = options.client ?? fakeClient({ models: MODELS })
  const runtime = createWorkBuddyRuntime(testDeps.deps, variant, {
    client,
    skipTransport: true,
    desktopPath,
    ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.usagePollMs === undefined ? {} : { usagePollMs: options.usagePollMs }),
  })
  const result: Harness = { testDeps, runtime, client, desktopPath }
  HARNESSES.push(result)
  return result
}

/** Foreign plugin identifiers composed locally: this spec proves they are ignored, not declares them. */
const FOREIGN_PLUGIN_ID = ['dsh', 'connect', 'workbuddy'].join('-')
const FOREIGN_BRIDGE_ID = ['llm', 'workbuddy'].join('-')
const FOREIGN_BRIDGE_NAME = ['dsh', 'workbuddy', 'bridge'].join('-')

describe('WorkBuddyRuntime signed out', () => {
  it('initializes without a credential, serves no models, and warns actionably', async () => {
    const { runtime, client } = await harness()
    await runtime.init()
    const status = runtime.status()
    expect(status.state).toBe('needs-credential')
    expect(status.catalog.models).toEqual([])
    expect(status.catalog.source).toBe('builtin')
    expect(status.warnings).toEqual([
      expect.objectContaining({ code: 'no-credential', level: 'info' }),
    ])
    expect(status.credential).toBeUndefined()
    expect(client.calls.fetchModels).toBe(0)
    // No billed usage read happens without an explicit action.
    expect(client.calls.fetchCredits).toBe(0)
    expect(status.probes).toEqual({ supported: true, consent: false, rows: [] })
  })

  it('reports a missing sign-in as a failed action and ignores unknown actions', async () => {
    const { runtime } = await harness()
    await runtime.init()
    await expect(runtime.action({ type: 'refresh-account', provider: 'workbuddy' }))
      .rejects.toMatchObject({ code: 'not_configured', message: expect.stringContaining('未找到 WorkBuddy 桌面端登录') })
    await expect(runtime.action({ type: 'refresh-status' })).resolves.toEqual({})
    await expect(runtime.action({ type: 'clear-secret', provider: 'workbuddy' })).resolves.toEqual({})
  })
})

describe('WorkBuddyRuntime signed in', () => {
  it('reads the desktop sign-in, fetches the catalog on init, and masks personal data', async () => {
    const now = Date.now()
    const { runtime, client, testDeps } = await harness({ document: CN_DOCUMENT(now + 3_600_000) })
    await runtime.init()
    await live(runtime)
    const status = runtime.status()
    expect(status.state).toBe('ready')
    expect(status.catalog.source).toBe('live')
    expect(status.catalog.models.map((model) => model.id)).toEqual(['glm-5.3', 'glm-5.2'])
    expect(status.catalog.models[0]).toMatchObject({
      enabled: true,
      multiplier: 0.79,
      inputs: ['text', 'image'],
      contextWindow: 1_000_000,
    })
    expect(status.catalog.models[1]).toMatchObject({ enabled: true, multiplier: 0, badges: ['免费'] })
    expect(status.account?.label).toBe('a***@example.com')
    expect(status.credential).toMatchObject({ source: 'app', writable: false })
    expect(status.credential?.masked).toBe('****oken')
    expect(status.warnings).toEqual([])
    expect(client.calls.fetchModels).toBe(1)
    expect(testDeps.emitted).toContain('llm/adapters-updated')
    // No secret may appear in the status document.
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('secret-access-token')
    expect(serialized).not.toContain('secret-refresh-token')
  })

  it('scans the catalog once per status build instead of once per model', async () => {
    const now = Date.now()
    const { runtime } = await harness({ document: CN_DOCUMENT(now + 3_600_000), client: fakeClient({ models: MODELS }) })
    await runtime.init()
    await live(runtime)
    const catalog = (runtime as unknown as { catalog: { current(): unknown } }).catalog
    const current = vi.spyOn(catalog, 'current')
    runtime.status()
    // Pre-fix status called current() once at the top, once per model in the
    // model loop and once per model again for the probe table (O(N²)).
    expect(current).toHaveBeenCalledTimes(1)
    current.mockRestore()
  })

  it('persists the account and catalog snapshot for the next start', async () => {
    const now = Date.now()
    const { runtime, testDeps } = await harness({ document: CN_DOCUMENT(now + 3_600_000) })
    await runtime.init()
    await live(runtime)
    expect(await testDeps.prefs.get('provider:workbuddy:account')).toMatchObject({ identity: 'uid-1:ent-1' })
    const catalog = await testDeps.prefs.get<{ entries: Record<string, { models: WorkBuddyUpstreamModel[] }> }>(
      'provider:workbuddy:catalog',
    )
    expect(catalog?.entries['uid-1:ent-1']?.models.map((model) => model.id)).toEqual(['glm-5.3', 'glm-5.2'])
  })

  it('serves the saved catalog when a later fetch fails', async () => {
    const now = Date.now()
    const first = await harness({ document: CN_DOCUMENT(now + 3_600_000) })
    await first.runtime.init()
    await live(first.runtime)
    await first.runtime.dispose()
    const failing = fakeClient({ modelsError: new Error('upstream 502') })
    const second = createWorkBuddyRuntime(first.testDeps.deps, CN_VARIANT, {
      client: failing,
      skipTransport: true,
      desktopPath: join(first.testDeps.paths.home, 'workbuddy.info'),
    })
    first.runtime = second
    first.client = failing
    await second.init()
    await settle(() => second.status().catalog.error !== undefined, 'catalog failure')
    const status = second.status()
    expect(status.catalog.source).toBe('saved')
    expect(status.catalog.models.map((model) => model.id)).toEqual(['glm-5.3', 'glm-5.2'])
    expect(status.catalog.error).toContain('upstream 502')
    expect(status.warnings).toEqual([expect.objectContaining({ code: 'catalog-error', level: 'warn' })])
    expect(status.state).toBe('ready')
  })

  it('refreshes an expired token into the vault and reports the plugin source', async () => {
    const now = Date.now()
    const client = fakeClient({
      models: MODELS,
      refresh: async () => ({ accessToken: 'refreshed-access-token', refreshToken: 'rotated-refresh', expiresInSec: 3600 }),
    })
    const { runtime, testDeps } = await harness({ document: CN_DOCUMENT(now - 1000), client })
    await runtime.init()
    await settle(() => runtime.status().credential?.source === 'plugin', 'refreshed credential')
    const status = runtime.status()
    expect(status.credential).toMatchObject({ source: 'plugin', expiresAt: expect.any(Number) })
    expect(status.credential?.masked).toBe('****oken')
    const stored = await testDeps.vault.read<{ version: number, credential: { accessToken: string } }>('workbuddy-cn')
    expect(stored?.version).toBe(1)
    expect(stored?.credential.accessToken).toBe('refreshed-access-token')
    expect(JSON.stringify(status)).not.toContain('refreshed-access-token')
    expect(client.calls.refreshToken).toBe(1)
  })
})

describe('WorkBuddyRuntime standalone profile', () => {
  /** Write the files a previous, unrelated plugin used to own. */
  const seedForeignState = async (paths: TestDeps['paths']): Promise<void> => {
    const { mkdir } = await import('node:fs/promises')
    await writeFile(
      join(paths.home, '.workbuddy-model-visibility.json'),
      JSON.stringify({
        version: 1,
        accounts: { 'uid-1:ent-1': { account: 'uid-1:ent-1', disabled: ['glm-5.2'], updatedAtMs: 1 } },
      }),
    )
    await writeFile(join(paths.home, '.workbuddy-probe.json'), JSON.stringify({ version: 2, records: {} }))
    await writeFile(join(paths.home, '.workbuddy-catalog.json'), JSON.stringify({ version: 1, entries: {} }))
    await writeFile(join(paths.home, '.workbuddy-app-version.json'), JSON.stringify({ version: '1.0.0' }))
    const profileDir = join(paths.home, 'profile')
    await mkdir(profileDir, { recursive: true })
    paths.profileDir = profileDir
    await writeFile(
      join(profileDir, 'cordis.patch.yml'),
      [
        `- id: ${FOREIGN_BRIDGE_ID}`,
        `  name: ${FOREIGN_BRIDGE_NAME}`,
        '  config:',
        '    probeConsent: true',
        `- id: ${FOREIGN_PLUGIN_ID}`,
        `  name: ${FOREIGN_PLUGIN_ID}`,
        '  config:',
        '    regions:',
        '      cn:',
        '        offModelIds:',
        '          - glm-5.3',
        '',
      ].join('\n'),
    )
  }

  it('ignores files and profile rows owned by a different plugin', async () => {
    const now = Date.now()
    const { runtime, testDeps } = await harness({
      document: CN_DOCUMENT(now + 3_600_000),
      seed: seedForeignState,
    })
    await runtime.init()
    await live(runtime)
    const status = runtime.status()
    // No visibility, consent, probe, catalog, or version state was imported.
    expect(status.catalog.source).toBe('live')
    expect(status.catalog.models.every((model) => model.enabled)).toBe(true)
    expect(status.probes?.consent).toBe(false)
    expect(await testDeps.prefs.get('provider:workbuddy:probes')).toBeUndefined()
    expect(await testDeps.prefs.get('provider:workbuddy:version')).toBeUndefined()
  })

  it('reports needs-credential on a fresh profile with no desktop sign-in, without crashing', async () => {
    const { runtime, client } = await harness({ seed: seedForeignState })
    await runtime.init()
    const status = runtime.status()
    expect(status.state).toBe('needs-credential')
    expect(status.catalog.models).toEqual([])
    expect(status.catalog.source).toBe('builtin')
    expect(status.warnings).toEqual([expect.objectContaining({ code: 'no-credential', level: 'info' })])
    expect(client.calls.fetchModels).toBe(0)
  })
})

describe('WorkBuddyRuntime diagnosable failures', () => {
  it('reports a credential for the other product as an error state with an actionable warning', async () => {
    const now = Date.now()
    const { runtime } = await harness({ document: AI_DOCUMENT(now + 3_600_000) })
    await runtime.init()
    const status = runtime.status()
    expect(status.state).toBe('error')
    expect(status.catalog.models).toEqual([])
    expect(status.warnings).toEqual([expect.objectContaining({ code: 'credential-unusable', level: 'error' })])
    expect(status.warnings[0]?.message).toContain('WorkBuddy AI credential')
  })

  it('brings the model group back once a credential starts working again', async () => {
    const now = Date.now()
    let refreshFails = true
    const client = fakeClient({
      models: MODELS,
      refresh: async () => {
        if (refreshFails) throw new Error('refresh endpoint offline')
        return { accessToken: 'recovered-access', expiresInSec: 3600 }
      },
    })
    const { runtime } = await harness({ document: CN_DOCUMENT(now - 1000), client })
    await runtime.init()
    await settle(() => runtime.status().warnings.some((warning) => warning.code === 'credential-error'), 'failure')
    expect(runtime.status().catalog.models).toEqual([])
    refreshFails = false
    await runtime.action({ type: 'refresh-account', provider: 'workbuddy' })
    await live(runtime)
    expect(runtime.status().state).toBe('ready')
    expect(runtime.status().catalog.models.length).toBeGreaterThan(0)
  })

  it('reports a dead refresh token as a hard credential failure, not a ready route', async () => {
    const now = Date.now()
    const client = fakeClient({
      models: MODELS,
      refresh: async () => {
        throw new Error('refresh endpoint rejected the session')
      },
    })
    const { runtime } = await harness({ document: CN_DOCUMENT(now - 1000), client })
    await runtime.init()
    await settle(() => runtime.status().warnings.some((warning) => warning.code === 'credential-error'), 'credential error')
    const status = runtime.status()
    expect(status.state).toBe('error')
    expect(status.warnings.map((warning) => warning.code)).toContain('credential-error')
    // The failed refresh is an expected outcome: init must not have thrown.
    expect(status.catalog.models.length).toBe(0)
  })
})

describe('WorkBuddyRuntime actions', () => {
  it('reads the quota on its own at startup and re-reads it on the explicit action', async () => {
    const now = Date.now()
    const credits: WorkBuddyCredits = {
      total: 120,
      accounts: [{ packageName: '基础包', remain: 120, size: 200, endTimeMs: now + 24 * 3600 * 1000 }],
      expiry: {
        within24h: { total: 120, packages: 1, earliestEndTimeMs: now + 24 * 3600 * 1000 },
        within3d: { total: 120, packages: 1 },
        within7d: { total: 120, packages: 1 },
      },
    }
    const { runtime, client } = await harness({ document: CN_DOCUMENT(now + 3_600_000), client: fakeClient({ models: MODELS, credits }) })
    await runtime.init()
    await live(runtime)
    // First load fills the credits card without a manual refresh, like the
    // other providers; the read is a background one and must not gate startup.
    await creditsSettled(runtime)
    expect(client.calls.fetchCredits).toBe(1)
    expect(runtime.status().credits).toMatchObject({ kind: 'credits', remaining: 120, total: 200 })
    expect(runtime.status().warnings).toEqual([expect.objectContaining({ code: 'credits-expiring-24h' })])
    const result = await runtime.action({ type: 'refresh-usage', provider: 'workbuddy' })
    expect(result.message).toContain('额度已刷新')
    expect(runtime.status().credits).toMatchObject({ kind: 'credits', remaining: 120, total: 200 })
    expect(client.calls.fetchCredits).toBe(2)
  })

  it('does not let the first usage read hold up startup', async () => {
    const now = Date.now()
    const { runtime, client } = await harness({
      document: CN_DOCUMENT(now + 3_600_000),
      client: fakeClient({ models: MODELS }),
      pollMs: 1_000,
    })
    let release: (credits: WorkBuddyCredits) => void = () => {}
    client.fetchCredits = async () => {
      client.calls.fetchCredits += 1
      return await new Promise<WorkBuddyCredits>((resolve) => { release = resolve })
    }
    // Would time out if init awaited the billed read: the route must start with
    // the cards it can already build and announce the credits when they land.
    await runtime.init()
    await settle(() => client.calls.fetchCredits === 1, 'usage read started')
    expect(runtime.status().credits).toBeUndefined()
    // The sign-in sweep runs while that read is still pending and must not start
    // a second billed request; the single flight owns the answer.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(client.calls.fetchCredits).toBe(1)
    release({ total: 3, accounts: [{ packageName: 'p', remain: 3, size: 3 }] })
    await creditsSettled(runtime)
    expect(runtime.status().credits?.remaining).toBe(3)
  })

  it('reads the quota after a sign-in is discovered by the poll', async () => {
    const now = Date.now()
    const { runtime, client, desktopPath } = await harness({
      client: fakeClient({ models: MODELS, credits: { total: 42, accounts: [{ packageName: '基础包', remain: 42, size: 42 }] } }),
      pollMs: 1_000,
    })
    await runtime.init()
    expect(runtime.status().state).toBe('needs-credential')
    expect(client.calls.fetchCredits).toBe(0)
    // Signing in while DSH runs: the next sweep adopts the credential and must
    // fetch the new account's quota, not wait for the explicit refresh button.
    await writeFile(desktopPath, CN_DOCUMENT(now + 3_600_000))
    await creditsSettled(runtime)
    expect(runtime.status().state).toBe('ready')
    expect(runtime.status().credits).toMatchObject({ remaining: 42 })
    expect(client.calls.fetchCredits).toBe(1)
  })

  it('re-reads the quota for the account adopted after a switch', async () => {
    const now = Date.now()
    const credentialA: WorkBuddyCredential = {
      accessToken: 'token-account-a',
      refreshToken: 'refresh-account-a',
      expiresAtMs: now + 3_600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-account-a',
      nickname: 'Account A',
      source: 'desktop',
    }
    const credentialB: WorkBuddyCredential = {
      ...credentialA,
      accessToken: 'token-account-b',
      refreshToken: 'refresh-account-b',
      uid: 'uid-account-b',
      nickname: 'Account B',
    }
    const credentials = {
      active: credentialA,
      async current(): Promise<WorkBuddyCredential> { return this.active },
      async resolve(): Promise<WorkBuddyCredential> { return this.active },
    }
    const client = fakeClient({ models: MODELS })
    client.fetchCredits = async (credential) => {
      const fromA = credential.uid === credentialA.uid
      const label = fromA ? 'A package' : 'B package'
      const remain = fromA ? 10 : 20
      return { total: remain, accounts: [{ packageName: label, remain, size: 100 }] }
    }
    const { runtime } = await harness({ credentialStore: credentials, client, pollMs: 1_000 })
    await runtime.init()
    await creditsSettled(runtime)
    expect(runtime.status().credits?.remaining).toBe(10)
    // The switch drops A's quota; the next sweep must fetch B's on its own.
    credentials.active = credentialB
    await settle(() => runtime.status().credits?.remaining === 20, 'quota after account switch')
    expect(runtime.status().credits?.packages[0]?.name).toBe('B package')
    // A cached answer is not re-read just because a sweep runs: a second read
    // would mean one billed request per poll.
    const reads = client.calls.fetchCredits
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(client.calls.fetchCredits).toBe(reads)
  })

  it('re-reads the quota on the background usage poll', async () => {
    const now = Date.now()
    const { runtime, client } = await harness({
      document: CN_DOCUMENT(now + 3_600_000),
      client: fakeClient({ models: MODELS }),
      usagePollMs: 1_000,
    })
    await runtime.init()
    await creditsSettled(runtime)
    const firstRead = client.calls.fetchCredits
    expect(firstRead).toBe(1)
    // The scheduler floors intervals at one second; wait for the next tick.
    await settle(() => client.calls.fetchCredits > firstRead, 'periodic usage refresh')
  })

  it('reports a usage read failure without throwing', async () => {
    const now = Date.now()
    const { runtime } = await harness({
      document: CN_DOCUMENT(now + 3_600_000),
      client: fakeClient({ models: MODELS, creditsError: new Error('billing offline') }),
    })
    await runtime.init()
    await live(runtime)
    await expect(runtime.action({ type: 'refresh-usage', provider: 'workbuddy' }))
      .rejects.toMatchObject({ code: 'usage_refresh_failed', message: expect.stringContaining('额度刷新失败') })
    expect(runtime.status().credits?.error).toContain('billing offline')
    expect(runtime.status().warnings).toEqual([expect.objectContaining({ code: 'credits-error' })])
  })

  it('discards a billed answer fetched for the previous account after a switch', async () => {
    const now = Date.now()
    const credentialA: WorkBuddyCredential = {
      accessToken: 'token-account-a',
      refreshToken: 'refresh-account-a',
      expiresAtMs: now + 3_600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-account-a',
      nickname: 'Account A',
      source: 'desktop',
    }
    const credentialB: WorkBuddyCredential = {
      ...credentialA,
      accessToken: 'token-account-b',
      refreshToken: 'refresh-account-b',
      uid: 'uid-account-b',
      nickname: 'Account B',
    }
    const credentials = {
      active: credentialA,
      async current(): Promise<WorkBuddyCredential> { return this.active },
      async resolve(): Promise<WorkBuddyCredential> { return this.active },
    }
    const client = fakeClient({ models: MODELS })
    let usageCalls = 0
    let release: (credits: WorkBuddyCredits) => void = () => {}
    const gate = new Promise<WorkBuddyCredits>((resolve) => { release = resolve })
    client.fetchCredits = async () => {
      usageCalls += 1
      return await gate
    }

    const { runtime } = await harness({ credentialStore: credentials, client })
    await runtime.init()
    await live(runtime)

    const pending = runtime.action({ type: 'refresh-usage', provider: 'workbuddy' })
    await vi.waitFor(() => { expect(usageCalls).toBe(1) })

    credentials.active = credentialB
    await runtime.action({ type: 'refresh-account', provider: 'workbuddy' })
    // The switch drops A's quota immediately rather than showing it until the
    // next periodic read.
    expect(runtime.status().credits).toBeUndefined()

    release({ total: 999, accounts: [{ packageName: 'A package', remain: 999, size: 1_000 }] })
    await expect(pending).rejects.toMatchObject({ code: 'stale_identity' })
    expect(runtime.status().credits).toBeUndefined()

    client.fetchCredits = async () => ({ total: 7, accounts: [{ packageName: 'B package', remain: 7, size: 10 }] })
    await runtime.action({ type: 'refresh-usage', provider: 'workbuddy' })
    expect(runtime.status().credits?.remaining).toBe(7)
  })

  it('keeps the stale_identity code when the account changes without an adoptIdentity', async () => {
    const now = Date.now()
    const credentialA: WorkBuddyCredential = {
      accessToken: 'token-account-a',
      refreshToken: 'refresh-account-a',
      expiresAtMs: now + 3_600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-account-a',
      nickname: 'Account A',
      source: 'desktop',
    }
    const credentialB: WorkBuddyCredential = {
      ...credentialA,
      accessToken: 'token-account-b',
      refreshToken: 'refresh-account-b',
      uid: 'uid-account-b',
      nickname: 'Account B',
    }
    const credentials = {
      active: credentialA,
      async current(): Promise<WorkBuddyCredential> { return this.active },
      async resolve(): Promise<WorkBuddyCredential> { return this.active },
    }
    const client = fakeClient({ models: MODELS })
    let usageCalls = 0
    let release: (credits: WorkBuddyCredits) => void = () => {}
    const gate = new Promise<WorkBuddyCredits>((resolve) => { release = resolve })
    client.fetchCredits = async () => {
      usageCalls += 1
      return await gate
    }

    const { runtime } = await harness({ credentialStore: credentials, client })
    await runtime.init()
    await live(runtime)

    const pending = runtime.action({ type: 'refresh-usage', provider: 'workbuddy' })
    await vi.waitFor(() => { expect(usageCalls).toBe(1) })

    // The credentials source changes out of band; no refresh-account/adopt
    // moves the generation. The answer still belongs to A and must be reported
    // with the stable stale code, not re-wrapped as a billing failure.
    credentials.active = credentialB
    release({ total: 999, accounts: [{ packageName: 'A package', remain: 999, size: 1_000 }] })

    await expect(pending).rejects.toMatchObject({ code: 'stale_identity' })
    expect(runtime.status().credits).toBeUndefined()
  })

  it('reports a discarded catalog read instead of claiming an update', async () => {
    const now = Date.now()
    const credentialA: WorkBuddyCredential = {
      accessToken: 'token-account-a',
      refreshToken: 'refresh-account-a',
      expiresAtMs: now + 3_600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-account-a',
      nickname: 'Account A',
      source: 'desktop',
    }
    const credentialB: WorkBuddyCredential = {
      ...credentialA,
      accessToken: 'token-account-b',
      refreshToken: 'refresh-account-b',
      uid: 'uid-account-b',
      nickname: 'Account B',
    }
    const credentials = {
      active: credentialA,
      async current(): Promise<WorkBuddyCredential> { return this.active },
      async resolve(): Promise<WorkBuddyCredential> { return this.active },
    }
    const client = fakeClient({ models: MODELS })
    const { runtime } = await harness({ credentialStore: credentials, client })
    await runtime.init()
    await live(runtime)

    let fetches = 0
    let release: (models: readonly WorkBuddyUpstreamModel[]) => void = () => {}
    const gate = new Promise<readonly WorkBuddyUpstreamModel[]>((resolve) => { release = resolve })
    client.fetchModels = async () => {
      fetches += 1
      if (fetches === 1) return await gate
      return MODELS
    }

    const pending = runtime.action({ type: 'refresh-catalog', provider: 'workbuddy' })
    await vi.waitFor(() => { expect(fetches).toBe(1) })

    credentials.active = credentialB
    await runtime.action({ type: 'refresh-account', provider: 'workbuddy' })
    release(MODELS)
    // The stale A read is dropped and the action says so instead of reporting
    // "updated N models" for a result that was never published.
    await expect(pending).rejects.toMatchObject({ code: 'stale_identity' })
    expect(runtime.status().catalog.source).toBe('live')
  })

  it('toggles model visibility per account and announces the change', async () => {
    const now = Date.now()
    const { runtime, testDeps } = await harness({ document: CN_DOCUMENT(now + 3_600_000) })
    await runtime.init()
    await live(runtime)
    testDeps.emitted.length = 0
    const disabled = await runtime.action({ type: 'set-model-enabled', provider: 'workbuddy', modelId: 'glm-5.2', enabled: false })
    expect(disabled.message).toContain('已停用 1 个模型')
    expect(runtime.status().catalog.models.find((model) => model.id === 'glm-5.2')?.enabled).toBe(false)
    expect(testDeps.emitted).toContain('llm/adapters-updated')
    expect(testDeps.notifications()).toBeGreaterThan(0)
    await runtime.action({ type: 'set-models-enabled', provider: 'workbuddy', modelIds: ['glm-5.3', 'missing'], enabled: false })
    expect(runtime.status().catalog.models.every((model) => !model.enabled)).toBe(true)
    const visibility = await testDeps.prefs.get<{ accounts: Record<string, { disabled: string[] }> }>(
      'provider:workbuddy:visibility',
    )
    expect(visibility?.accounts['uid-1:ent-1']?.disabled).toEqual(['glm-5.2', 'glm-5.3'])
  })

  it('refuses visibility writes when the credential has no stable user id', async () => {
    const now = Date.now()
    const document = JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: now + 3_600_000, domain: 'www.codebuddy.cn' },
      account: { nickname: 'Tester' },
    })
    const { runtime } = await harness({ document })
    await runtime.init()
    await live(runtime)
    await expect(runtime.action({ type: 'set-model-enabled', provider: 'workbuddy', modelId: 'glm-5.2', enabled: false }))
      .rejects.toMatchObject({ code: 'identity_unavailable', message: expect.stringContaining('缺少账号标识') })
    expect(runtime.status().catalog.models.every((model) => model.enabled)).toBe(true)
  })

  it('rejects the CN max-context switch instead of reporting a no-op as success', async () => {
    const now = Date.now()
    const { runtime } = await harness({ document: CN_DOCUMENT(now + 3_600_000) })
    await runtime.init()
    await live(runtime)
    await expect(runtime.action({ type: 'set-max-context', provider: 'workbuddy', useMax: true }))
      .rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('仅 WorkBuddy AI') })
    expect(runtime.status().catalog.models.every((model) => model.useMaxContext === false)).toBe(true)
  })

  it('switches the international catalog between default and maximum windows', async () => {
    const now = Date.now()
    const intlModel: WorkBuddyUpstreamModel = {
      id: 'hy4-preview-f',
      name: 'Hy4 preview',
      contextWindow: 300_000,
      defaultContextWindow: 300_000,
      supportedContextWindows: [300_000, 1_000_000],
      maxTokens: 64_000,
      supportsImages: true,
    }
    const { runtime, testDeps } = await harness({
      variant: AI_VARIANT,
      document: AI_DOCUMENT(now + 3_600_000),
      client: fakeClient({ models: [intlModel] }),
    })
    await runtime.init()
    await live(runtime)
    // The AI preference defaults to the largest declared window.
    expect(runtime.status().catalog.models[0]).toMatchObject({ contextWindow: 1_000_000, useMaxContext: true })
    testDeps.emitted.length = 0
    const result = await runtime.action({ type: 'set-max-context', provider: 'workbuddy-ai', useMax: false })
    expect(result.message).toContain('默认上下文窗口')
    expect(runtime.status().catalog.models[0]).toMatchObject({ contextWindow: 300_000, useMaxContext: false })
    expect(await testDeps.prefs.get('provider:workbuddy-ai:max-context')).toBe(false)
    expect(testDeps.emitted).toContain('llm/adapters-updated')
  })

  it('gates probes on consent, records per-model results, and rejects unknown models', async () => {
    const now = Date.now()
    const probe = (modelId: string, effort: string | undefined): ProbeAttempt => {
      if (modelId === 'glm-5.2') {
        if (effort === undefined) return { status: 200, streamed: true }
        if (effort === 'low' || effort === 'high') return { status: 200, streamed: true }
        return { status: 400, streamed: false, errorCode: 'invalid_parameter_value' }
      }
      return { status: 200, streamed: true }
    }
    const { runtime, client } = await harness({
      document: CN_DOCUMENT(now + 3_600_000),
      client: fakeClient({ models: MODELS, probe }),
    })
    await runtime.init()
    await live(runtime)
    await expect(runtime.action({ type: 'probe-model', provider: 'workbuddy', modelId: 'glm-5.2' }))
      .rejects.toMatchObject({ code: 'probe_forbidden', message: expect.stringContaining('未开启推理档位探测授权') })
    expect(client.calls.probeEffort).toEqual([])

    await runtime.action({ type: 'set-probe-consent', provider: 'workbuddy', consent: true })
    expect(runtime.status().probes?.consent).toBe(true)
    const probed = await runtime.action({ type: 'probe-model', provider: 'workbuddy', modelId: 'glm-5.2' })
    expect(probed.message).toContain('low')
    const row = runtime.status().probes?.rows.find((entry) => entry.modelId === 'glm-5.2')
    expect(row).toMatchObject({ state: 'ok', efforts: ['low', 'high'] })
    // The declared-set model never becomes a probe candidate.
    const declared = await runtime.action({ type: 'probe-model', provider: 'workbuddy', modelId: 'glm-5.3' })
    expect(declared.message).toContain('无需探测')
    await expect(runtime.action({ type: 'probe-model', provider: 'workbuddy', modelId: 'missing' }))
      .rejects.toMatchObject({ code: 'unknown_model', message: expect.stringContaining('模型不存在') })
  })

  it('tests model availability serially and stops on an auth failure', async () => {
    const now = Date.now()
    const probe = (modelId: string): ProbeAttempt => {
      if (modelId === 'glm-5.3') return { status: 200, streamed: true }
      if (modelId === 'glm-5.2') return { status: 401, streamed: false }
      return { status: 402, streamed: false }
    }
    const { runtime, client } = await harness({
      document: CN_DOCUMENT(now + 3_600_000),
      client: fakeClient({ models: MODELS, probe }),
    })
    await runtime.init()
    await live(runtime)
    await expect(runtime.action({ type: 'test-models', provider: 'workbuddy', modelIds: ['glm-5.3'] }))
      .rejects.toMatchObject({ code: 'probe_forbidden', message: expect.stringContaining('未开启推理档位探测授权') })
    await runtime.action({ type: 'set-probe-consent', provider: 'workbuddy', consent: true })
    const result = await runtime.action({
      type: 'test-models',
      provider: 'workbuddy',
      modelIds: ['glm-5.3', 'missing', 'glm-5.2'],
    })
    expect(result.data).toEqual({
      results: [
        { modelId: 'glm-5.3', verdict: 'available' },
        { modelId: 'missing', verdict: 'unknown-model' },
        { modelId: 'glm-5.2', verdict: 'auth' },
      ],
    })
    expect(result.message).toContain('1/3')
    expect(result.message).toContain('登录状态无效')
    // Only the available model and the auth failure were actually requested.
    expect(client.calls.probeEffort).toEqual(['glm-5.3:baseline', 'glm-5.2:baseline'])
  })

  it('refresh-catalog refreshes on demand and reports failures as a failed action', async () => {
    const now = Date.now()
    const { runtime, client } = await harness({ document: CN_DOCUMENT(now + 3_600_000) })
    await runtime.init()
    await live(runtime)
    const refreshed = await runtime.action({ type: 'refresh-catalog', provider: 'workbuddy' })
    expect(refreshed.message).toContain('2 个模型')
    expect(client.calls.fetchModels).toBe(2)
    client.fetchModels = async () => {
      throw new Error('upstream 503')
    }
    await expect(runtime.action({ type: 'refresh-catalog', provider: 'workbuddy' }))
      .rejects.toMatchObject({ code: 'catalog_refresh_failed', message: expect.stringContaining('模型目录刷新失败') })
    expect(runtime.status().catalog.error).toContain('upstream 503')
  })

  it('refreshAll refreshes the catalog and the billed usage', async () => {
    const now = Date.now()
    const credits: WorkBuddyCredits = { total: 5, accounts: [{ packageName: 'p', remain: 5, size: 10 }] }
    const { runtime, client } = await harness({
      document: CN_DOCUMENT(now + 3_600_000),
      client: fakeClient({ models: MODELS, credits }),
    })
    await runtime.init()
    await live(runtime)
    await creditsSettled(runtime)
    // One read already came from startup; refreshAll performs its own.
    expect(client.calls.fetchCredits).toBe(1)
    await runtime.refreshAll()
    expect(client.calls.fetchModels).toBe(2)
    expect(client.calls.fetchCredits).toBe(2)
    expect(runtime.status().credits?.remaining).toBe(5)
  })
})

describe('WorkBuddyRuntime transport', () => {
  it('starts the loopback shim and registers the adapter for its route', async () => {
    const now = Date.now()
    const testDeps = await createTestDeps()
    const desktopPath = join(testDeps.paths.home, 'workbuddy.info')
    await writeFile(desktopPath, CN_DOCUMENT(now + 3_600_000))
    const client = fakeClient({ models: MODELS })
    const runtime = createWorkBuddyRuntime(testDeps.deps, CN_VARIANT, { client, desktopPath })
    HARNESSES.push({ testDeps, runtime, client, desktopPath })
    await runtime.init()
    expect(testDeps.adapters).toHaveLength(1)
    expect(testDeps.adapters[0]?.providers).toEqual(['workbuddy'])
    expect(runtime.status().state).toBe('ready')
    expect(runtime.status().warnings).toEqual([])
    await runtime.dispose()
    expect(testDeps.adapters[0]?.released).toBe(true)
  })
})

describe('WorkBuddyRuntime lifecycle', () => {
  it('disposes idempotently without a transport or in-flight work', async () => {
    const { runtime } = await harness({ document: CN_DOCUMENT(Date.now() + 3_600_000) })
    await runtime.init()
    await live(runtime)
    await runtime.dispose()
    await runtime.dispose()
    await expect(runtime.action({ type: 'refresh-usage', provider: 'workbuddy' })).resolves.toEqual({})
  })

  it('keeps the two variants independent', async () => {
    const now = Date.now()
    const cn = await harness({ document: CN_DOCUMENT(now + 3_600_000) })
    const ai = await harness({ variant: AI_VARIANT, document: AI_DOCUMENT(now + 3_600_000) })
    await Promise.all([cn.runtime.init(), ai.runtime.init()])
    await Promise.all([live(cn.runtime), live(ai.runtime)])
    expect(cn.runtime.status().region).toBe('cn')
    expect(ai.runtime.status().region).toBe('global')
    expect(ai.runtime.status().account?.label).toBe('Tester')
    expect(ai.runtime.status().catalog.models.map((model) => model.id)).toEqual(['glm-5.3', 'glm-5.2'])
  })
})

describe('WorkBuddyRuntime daily check-in', () => {
  const activity = (): WorkBuddyCheckinActivity => ({
    active: true,
    todayCheckedIn: false,
    streakDays: 3,
    dailyCredit: 100,
    todayCredit: 0,
    totalCredits: 300,
    weekCheckinDays: 3,
    activityName: 'Buddy应用',
    themeName: 'Buddy加油站',
  })

  it('claims the daily reward, logs it and refreshes the quota', async () => {
    const now = Date.now()
    const client = fakeClient({
      models: MODELS,
      checkin: activity(),
      claim: { ok: true, credit: 100 },
    })
    const { runtime, testDeps } = await harness({ document: CN_DOCUMENT(now + 3_600_000), client })
    await runtime.init()
    await live(runtime)
    await creditsSettled(runtime)
    const before = client.calls.fetchCredits
    const result = await runtime.action({ type: 'checkin', provider: 'workbuddy' })
    expect(result.code).toBe('checkin-claimed')
    expect(result.message).toContain('签到成功')
    const checkin = runtime.status().checkin
    expect(checkin).toMatchObject({ supported: true, state: 'claimed', reward: 100 })
    expect(checkin?.log[0]).toMatchObject({ code: 'checkin-claimed', ok: true, params: { reward: 100 } })
    expect(client.calls.claimCheckin).toBe(1)
    await settle(() => client.calls.fetchCredits > before, 'usage refresh after check-in')
    const stored = await testDeps.prefs.get<{ reward?: number, claimedDate?: string, log: unknown[] }>('provider:workbuddy:checkin')
    expect(stored?.reward).toBe(100)
    expect(typeof stored?.claimedDate).toBe('string')
    expect(stored?.log.length).toBeGreaterThan(0)
  })

  it('reports an already-claimed day without calling the claim endpoint', async () => {
    const now = Date.now()
    const client = fakeClient({
      models: MODELS,
      checkin: { ...activity(), todayCheckedIn: true, todayCredit: 100, totalCredits: 400 },
    })
    const { runtime } = await harness({ document: CN_DOCUMENT(now + 3_600_000), client })
    await runtime.init()
    await live(runtime)
    const result = await runtime.action({ type: 'checkin', provider: 'workbuddy' })
    expect(result).toMatchObject({ code: 'checkin-already', message: '今日已签到' })
    expect(client.calls.claimCheckin).toBe(0)
    expect(runtime.status().checkin).toMatchObject({ state: 'claimed', reward: 100 })
  })

  it('refuses to claim when the activity is not running', async () => {
    const now = Date.now()
    const client = fakeClient({
      models: MODELS,
      checkin: { ...activity(), active: false },
    })
    const { runtime } = await harness({ document: CN_DOCUMENT(now + 3_600_000), client })
    await runtime.init()
    await live(runtime)
    await expect(runtime.action({ type: 'checkin', provider: 'workbuddy' })).rejects.toMatchObject({
      code: 'checkin_no_campaign',
      message: expect.stringContaining('暂无可领取'),
    })
    expect(client.calls.claimCheckin).toBe(0)
    expect(runtime.status().checkin?.supported).toBe(false)
  })

  it('persists the automatic schedule and catches up after enabling it', async () => {
    const now = Date.now()
    const client = fakeClient({
      models: MODELS,
      checkin: activity(),
      claim: { ok: true, credit: 100 },
    })
    const { runtime } = await harness({ document: CN_DOCUMENT(now + 3_600_000), client })
    await runtime.init()
    await live(runtime)
    await settle(() => runtime.status().checkin?.supported === true, 'check-in activity')
    const timeOnly = await runtime.action({ type: 'set-checkin', provider: 'workbuddy', minute: 60 })
    expect(timeOnly).toMatchObject({ code: 'checkin-time-set', params: { time: '01:00' } })
    const enabled = await runtime.action({ type: 'set-checkin', provider: 'workbuddy', enabled: true })
    expect(enabled).toMatchObject({ code: 'checkin-schedule-on', params: { time: '01:00' } })
    // 01:00 UTC+8 is already past at any real test run time, so enabling arms a
    // catch-up claim for today.
    await settle(() => runtime.status().checkin?.state === 'claimed', 'catch-up claim')
    expect(client.calls.claimCheckin).toBe(1)
  })

  it('does not expose check-in on the international route', async () => {
    const now = Date.now()
    const client = fakeClient({ models: MODELS, checkin: activity() })
    const { runtime } = await harness({ variant: AI_VARIANT, document: AI_DOCUMENT(now + 3_600_000), client })
    await runtime.init()
    await live(runtime)
    const status = runtime.status()
    expect(status.checkin).toBeUndefined()
    expect(status.capabilities.checkin).toBe(false)
    expect(client.calls.fetchCheckin).toBe(0)
  })
})
