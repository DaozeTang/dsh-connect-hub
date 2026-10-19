import { describe, expect, it } from 'vitest'
import { createFakeHost } from '../support/hub-host.ts'
import { createQoderProviders } from '../../src/providers/qoder/index.ts'
import { createWorkBuddyProviders } from '../../src/providers/workbuddy/index.ts'
import { createTraeProviders } from '../../src/providers/trae/index.ts'
import type { ProviderRuntime } from '../../src/core/types.ts'

const SECRET_PATTERN = /eyJ[A-Za-z0-9_-]{10,}|pat_[A-Za-z0-9]|Bearer\s+[A-Za-z0-9._-]{10,}|-----BEGIN /u

async function createRuntimes(): Promise<{ runtimes: ProviderRuntime[]; host: Awaited<ReturnType<typeof createFakeHost>> }> {
  const host = await createFakeHost()
  const runtimes = [
    ...createQoderProviders(host.deps),
    ...createWorkBuddyProviders(host.deps),
    ...createTraeProviders(host.deps),
  ]
  return { runtimes, host }
}

describe('provider runtime set', () => {
  it('exposes the six expected routes with unique ids', async () => {
    const { runtimes, host } = await createRuntimes()
    try {
      expect(runtimes.map((runtime) => runtime.descriptor.id)).toEqual([
        'qoder', 'qoder-global', 'workbuddy', 'workbuddy-ai', 'trae', 'trae-global',
      ])
      for (const runtime of runtimes) {
        expect(runtime.descriptor.family).toBe(
          runtime.descriptor.id.startsWith('qoder') ? 'qoder' : runtime.descriptor.id.startsWith('workbuddy') ? 'workbuddy' : 'trae',
        )
        expect(runtime.descriptor.label.zh.length).toBeGreaterThan(0)
        expect(runtime.descriptor.label.en.length).toBeGreaterThan(0)
      }
    } finally {
      await host.cleanup()
    }
  })

  it('reports a contract-shaped, secret-free status before init', async () => {
    const { runtimes, host } = await createRuntimes()
    try {
      for (const runtime of runtimes) {
        const status = runtime.status()
        expect(status.id).toBe(runtime.descriptor.id)
        expect(status.family).toBe(runtime.descriptor.family)
        expect(status.region).toBe(runtime.descriptor.region)
        expect(['ready', 'needs-credential', 'error', 'signed-out']).toContain(status.state)
        expect(Array.isArray(status.catalog.models)).toBe(true)
        expect(Array.isArray(status.warnings)).toBe(true)
        expect(SECRET_PATTERN.test(JSON.stringify(status))).toBe(false)
      }
    } finally {
      await host.cleanup()
    }
  })

  it('registers one adapter route per provider on init and releases them on dispose', async () => {
    const { runtimes, host } = await createRuntimes()
    try {
      for (const runtime of runtimes) await runtime.init()
      for (const runtime of runtimes) expect(host.adapters).toContain(runtime.descriptor.id)
      await Promise.all(runtimes.map((runtime) => runtime.dispose()))
    } finally {
      await host.cleanup()
    }
  }, 30_000)
})
