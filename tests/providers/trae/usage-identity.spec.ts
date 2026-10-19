/**
 * Trae account-switch race: the AI region's pay-status answer for account A
 * must not be published after account B becomes active, and selectAccount must
 * not join A's in-flight usage read.
 */

import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeTraeOwnDocument, type TraeCredential } from '../../../src/providers/trae/auth.ts'
import { createTraeProviders } from '../../../src/providers/trae/index.ts'
import { makeFakeDeps, makeTempDir } from './helpers.ts'

const cleanups: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function aiCredential(name: string): TraeCredential {
  return {
    accessToken: `token-${name}`,
    refreshToken: `refresh-${name}`,
    userId: `user-${name}`,
    accountName: name,
    host: 'https://api.trae.ai',
    userRegion: 'sg',
    expiresAtMs: Date.now() + 3_600_000,
    refreshExpiresAtMs: Date.now() + 86_400_000,
    edition: 'solo-sg',
    source: 'dsh',
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('Trae usage identity', () => {
  it('discards the previous account pay status and starts a fresh usage flight on switch', async () => {
    const home = await makeTempDir('trae-identity-')
    cleanups.push(home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)

    let payCalls = 0
    let releaseFirst: (response: Response) => void = () => {}
    const firstPay = new Promise<Response>((resolve) => { releaseFirst = resolve })
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      if (!url.includes('/pay/ide_user_pay_status')) return json({})
      payCalls += 1
      if (payCalls === 1) return await firstPay
      return json({ user_pay_identity_str: 'Plan B' })
    })

    const bundle = makeFakeDeps({ home })
    const runtimes = createTraeProviders(bundle.deps)
    const runtime = runtimes[1]!
    await runtime.init()

    // Capture the first usage read so the test can await its completion after
    // releasing the stale answer (no timers, no polling).
    const internal = runtime as unknown as { refreshUsage(): Promise<void> }
    const originalRefreshUsage = internal.refreshUsage.bind(runtime)
    let firstUsage: Promise<void> | undefined
    internal.refreshUsage = () => {
      const run = originalRefreshUsage()
      firstUsage ??= run
      return run
    }

    bundle.vault.seed('trae-global', serializeTraeOwnDocument([aiCredential('Account A'), aiCredential('Account B')]))
    await runtime.action({ type: 'refresh-account', provider: 'trae-global' })
    await vi.waitFor(() => { expect(payCalls).toBe(1) })
    expect(firstUsage).toBeDefined()

    const accountB = runtime.status().accounts?.find(account => account.label === 'Account B')
    expect(accountB).toBeDefined()
    await runtime.action({ type: 'select-account', provider: 'trae-global', accountId: accountB!.id })
    // selectAccount must NOT join A's still-running read.
    await vi.waitFor(() => { expect(payCalls).toBe(2) })
    await vi.waitFor(() => { expect(runtime.status().credits?.plan).toBe('Plan B') })

    releaseFirst(json({ user_pay_identity_str: 'Plan A' }))
    await firstUsage
    expect(runtime.status().credits?.plan).toBe('Plan B')

    await runtime.dispose()
  })
})
