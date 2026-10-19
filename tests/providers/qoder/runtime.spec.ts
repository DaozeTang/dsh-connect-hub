import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QoderModelInfo } from '../../../src/providers/qoder/catalog.ts'
import { createQoderProviders } from '../../../src/providers/qoder/index.ts'
import { harness } from './host.ts'

let cleanup: string | undefined
afterEach(async () => {
  if (cleanup !== undefined) {
    await rm(cleanup, { recursive: true, force: true })
    cleanup = undefined
  }
})

describe('createQoderProviders', () => {
  it('returns the two independent regional routes with their own registrations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-runtime-'))
    cleanup = root
    const { deps, adapterRegistrations, directoryEntries } = harness(root)
    const runtimes = createQoderProviders(deps)
    expect(runtimes.map(runtime => runtime.descriptor.id)).toEqual(['qoder', 'qoder-global'])
    expect(runtimes.map(runtime => runtime.descriptor.region)).toEqual(['cn', 'global'])
    expect(runtimes.map(runtime => runtime.descriptor.family)).toEqual(['qoder', 'qoder'])

    for (const runtime of runtimes) await runtime.init()
    try {
      expect(adapterRegistrations).toEqual([['qoder'], ['qoder-global']])
      expect(directoryEntries).toEqual([
        { provider: 'qoder', settingsNs: 'qoder' },
        { provider: 'qoder-global', settingsNs: 'qoder-global' },
      ])
    } finally {
      for (const runtime of runtimes) await runtime.dispose()
    }
  })

  it('starts signed out without throwing and reports a needs-credential status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-runtime-'))
    cleanup = root
    const { deps, emitted, scheduler } = harness(root)
    const [cn] = createQoderProviders(deps)
    expect(cn).toBeDefined()
    await cn!.init()
    try {
      // The desktop probe runs in the background; wait for it to settle so the
      // signed-out warning is deterministic.
      await vi.waitFor(() => {
        expect(cn!.status().warnings.map(warning => warning.code)).toContain('no-credential')
      })
      const status = cn!.status()
      expect(status).toMatchObject({
        id: 'qoder',
        family: 'qoder',
        region: 'cn',
        state: 'needs-credential',
        catalog: { source: 'builtin', models: [] },
        capabilities: { usage: false, checkin: false, transfer: false, probes: false, multiAccount: false },
        checkin: { supported: true, enabled: false, minute: 600, state: 'unknown', log: [] },
      })
      // No stored PAT means no credential object at all: the UI must not show
      // a "saved by plugin" badge for a secret that does not exist.
      expect(status.credential).toBeUndefined()
      // The first probe is awaited and found nothing, so the status names the
      // desktop source directly instead of the generic "not configured" row.
      expect(status.warnings.map(warning => warning.code)).toContain('no-credential')
      expect(emitted).toEqual([])
      expect(scheduler.timers.has('qoder:qoder:credential-sweep')).toBe(true)
      expect(scheduler.timers.has('qoder:qoder:usage-poll')).toBe(true)
    } finally {
      await cn!.dispose()
    }
  })

  it('rejects an invalid PAT as a failed action without storing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-runtime-'))
    cleanup = root
    const { deps, vault } = harness(root)
    const [cn] = createQoderProviders(deps)
    await cn!.init()
    try {
      vi.stubGlobal('fetch', async () => new Response('rejected', { status: 401 }))
      await expect(cn!.action({ type: 'save-secret', provider: 'qoder', secret: 'bad-pat' }))
        .rejects.toMatchObject({ code: 'secret_rejected', message: expect.stringContaining('PAT 校验失败') })
      expect(vault.slots.has('qoder-cn')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      await cn!.dispose()
    }
  })

  it('handles signed-out actions and persists preferences per region', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-runtime-'))
    cleanup = root
    const { deps, prefs, scheduler } = harness(root)
    const [cn] = createQoderProviders(deps)
    await cn!.init()
    try {
      await expect(cn!.action({ type: 'refresh-catalog', provider: 'qoder' }))
        .rejects.toMatchObject({ code: 'not_configured', message: expect.stringContaining('尚未登录 Qoder') })
      await expect(cn!.action({ type: 'refresh-usage', provider: 'qoder' }))
        .rejects.toMatchObject({ code: 'not_configured', message: expect.stringContaining('尚未登录 Qoder') })
      await expect(cn!.action({ type: 'checkin', provider: 'qoder' }))
        .rejects.toMatchObject({ code: 'not_configured', message: expect.stringContaining('尚未登录 Qoder') })
      // Unknown / other-family actions are ignored, not thrown.
      expect(await cn!.action({ type: 'select-account', provider: 'qoder', accountId: 'x' })).toEqual({})
      expect(await cn!.action({ type: 'clear-secret', provider: 'qoder' })).toEqual({ message: 'Qoder 凭证已清除', code: 'credential-cleared' })
    } finally {
      await cn!.dispose()
    }

    const second = createQoderProviders(deps)[0]!
    await second.init()
    try {
      await second.action({ type: 'set-model-enabled', provider: 'qoder', modelId: 'cmodel', enabled: false })
      await second.action({ type: 'set-models-enabled', provider: 'qoder', modelIds: ['lite', 'auto'], enabled: false })
      await second.action({ type: 'set-max-context', provider: 'qoder', useMax: true })
      await second.action({ type: 'set-checkin', provider: 'qoder', enabled: true, minute: 700 })
      await second.action({ type: 'clear-checkin-log', provider: 'qoder' })
      const document = prefs.values.get('provider:qoder') as {
        disabledModels: string[]
        useMaxContext: boolean
        checkin: { enabled: boolean; minute: number; logs: unknown[] }
      }
      expect(new Set(document.disabledModels)).toEqual(new Set(['cmodel', 'lite', 'auto']))
      expect(document.useMaxContext).toBe(true)
      expect(document.checkin).toMatchObject({ enabled: true, minute: 700, logs: [] })
      expect(scheduler.timers.get('qoder:qoder:checkin')).toEqual({ kind: 'atUtc8', minute: 700 })
      const status = second.status()
      expect(status.catalog.models).toEqual([])
      expect(status.checkin).toMatchObject({ enabled: true, minute: 700 })
    } finally {
      await second.dispose()
    }
  })
})

/** Internals the catalog identity regression test drives; no production seam. */
interface QoderCatalogInternals {
  store: { savePat(pat: string): Promise<unknown> }
  adoptIdentity(): void
  client: { fetchModels(): Promise<QoderModelInfo[]> }
}

describe('Qoder catalog identity', () => {
  it('reports a publish-time identity discard as stale instead of success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-catalog-identity-'))
    cleanup = root
    const { deps } = harness(root)
    const [runtime] = createQoderProviders(deps)
    await runtime!.init()
    try {
      const internal = runtime as unknown as QoderCatalogInternals
      await internal.store.savePat('pat-account-a')
      internal.adoptIdentity()

      const modelA: QoderModelInfo = {
        id: 'only-for-a',
        name: 'Only For A',
        contextWindow: 200_000,
        maxTokens: 64_000,
        supportsImages: false,
        billing: { credits: 'x0.3', free: false },
      }
      let fetches = 0
      let release: (models: QoderModelInfo[]) => void = () => {}
      const gate = new Promise<QoderModelInfo[]>((resolve) => { release = resolve })
      internal.client.fetchModels = async () => {
        fetches += 1
        return await gate
      }

      const pending = runtime!.action({ type: 'refresh-catalog', provider: 'qoder' })
      await vi.waitFor(() => { expect(fetches).toBe(1) })

      // The vault changes out of band (no adoptIdentity). The answer belongs
      // to A and must be discarded, and the action must say so rather than
      // reporting success with the previous count.
      await internal.store.savePat('pat-account-b')
      release([modelA])

      await expect(pending).rejects.toMatchObject({ code: 'stale_identity' })
      expect(runtime!.status().catalog.models.map(model => model.id)).not.toContain(modelA.id)
      expect(runtime!.status().catalog.source).toBe('builtin')
    } finally {
      await runtime!.dispose()
    }
  })
})
