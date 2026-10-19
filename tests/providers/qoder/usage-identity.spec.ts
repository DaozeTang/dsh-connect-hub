/**
 * Qoder usage identity race: a quota answer fetched for PAT A must never be
 * published after the active PAT changed to B. The deferred credits client is
 * deterministic: no network, no timers, no real credential.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQoderProviders } from '../../../src/providers/qoder/index.ts'
import type { QoderCredits } from '../../../src/providers/qoder/upstream.ts'
import { harness } from './host.ts'

let cleanup: string | undefined
afterEach(async () => {
  if (cleanup !== undefined) {
    await rm(cleanup, { recursive: true, force: true })
    cleanup = undefined
  }
})

interface QoderInternals {
  store: { savePat(pat: string): Promise<unknown> }
  adoptIdentity(): void
  client: { fetchCredits(): Promise<QoderCredits> }
}

function creditsOf(remain: number): QoderCredits {
  return { accounts: [{ packageName: '个人额度', remain, size: 1_000 }] }
}

describe('Qoder usage identity', () => {
  it('discards credits fetched for the previous PAT and publishes the new one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-identity-'))
    cleanup = root
    const { deps } = harness(root)
    const [runtime] = createQoderProviders(deps)
    await runtime!.init()

    const internal = runtime as unknown as QoderInternals
    await internal.store.savePat('pat-account-a')
    internal.adoptIdentity()

    // Hold the first account's billed read open while the PAT switches.
    let release: (credits: QoderCredits) => void = () => {}
    const gate = new Promise<QoderCredits>((resolve) => { release = resolve })
    let calls = 0
    internal.client.fetchCredits = async () => {
      calls += 1
      return await gate
    }

    const pending = runtime!.action({ type: 'refresh-usage', provider: 'qoder' })
    await vi.waitFor(() => { expect(calls).toBe(1) })

    await internal.store.savePat('pat-account-b')
    internal.adoptIdentity()
    expect(runtime!.status().credits).toBeUndefined()

    release(creditsOf(999))
    await expect(pending).rejects.toMatchObject({ code: 'stale_identity' })
    // The stale answer must not resurrect A's balance for B.
    expect(runtime!.status().credits).toBeUndefined()

    internal.client.fetchCredits = async () => creditsOf(7)
    const refreshed = await runtime!.action({ type: 'refresh-usage', provider: 'qoder' })
    expect(refreshed.message).toContain('额度已刷新')
    expect(runtime!.status().credits?.remaining).toBe(7)
    await runtime!.dispose()
  })
})
