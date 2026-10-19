import { describe, expect, it } from 'vitest'
import { createFakeHost } from '../support/hub-host.ts'
import { createQoderProviders } from '../../src/providers/qoder/index.ts'
import type { ProviderRuntime } from '../../src/core/types.ts'

/**
 * Read-only live check against the real Qoder account. Opt-in only:
 * HUB_LIVE_PROFILE=<profile dir> HUB_LIVE_HOME=<dsh home> pnpm exec vitest run tests/live
 * Never sends a chat request; fetches the catalog and (unless disabled) credits.
 */
const profileDir = process.env['HUB_LIVE_PROFILE']
const home = process.env['HUB_LIVE_HOME']
const dataDir = process.env['HUB_LIVE_DATA_DIR']
const enabled = profileDir !== undefined && home !== undefined

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for live state')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe.skipIf(!enabled)('live qoder transport', () => {
  it('fetches a live catalog and reports readiness without leaking secrets', async () => {
    const host = await createFakeHost({ home, profileDir, dataDir })
    const runtimes: ProviderRuntime[] = createQoderProviders(host.deps)
    try {
      for (const runtime of runtimes) await runtime.init()
      const cn = runtimes.find((runtime) => runtime.descriptor.id === 'qoder')
      if (cn === undefined) throw new Error('missing qoder runtime')
      await waitFor(() => cn.status().catalog.source === 'live', 30_000)
      const status = cn.status()
      expect(status.state).toBe('ready')
      expect(status.catalog.models.length).toBeGreaterThan(0)
      expect(JSON.stringify(status)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/u)
      process.stdout.write(`live qoder: ${status.catalog.models.length} models, ${status.catalog.source}\n`)
    } finally {
      await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()))
      await host.cleanup()
    }
  }, 60_000)
})
