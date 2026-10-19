import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TraeCredential } from '../../../src/providers/trae/auth.ts'
import { refreshTraeCredential, TRAE_SUPERSEDED_EXCHANGE_TOKEN_PATH } from '../../../src/providers/trae/refresh.ts'

function credential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    accessToken: 'old-access-token',
    refreshToken: 'refresh-token-value',
    userId: 'user-1',
    host: 'https://api.trae.cn',
    userRegion: 'CN',
    expiresAtMs: Date.now() - 60_000,
    refreshExpiresAtMs: Date.now() + 86_400_000,
    edition: 'cn',
    source: 'desktop',
    ...overrides,
  }
}

interface FetchCall {
  url: string
  body: string
}

function stubRefreshExchange(calls: FetchCall[]): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' })
    return new Response(JSON.stringify({
      Result: {
        Token: 'rotated-access-token',
        RefreshToken: 'rotated-refresh-token',
        TokenExpireAt: Date.now() + 3_600_000,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Trae token refresh destination guard', () => {
  it('refuses a plaintext stored host without sending the refresh token', async () => {
    const calls: FetchCall[] = []
    stubRefreshExchange(calls)
    await expect(refreshTraeCredential(credential({ host: 'http://api.trae.cn' }))).rejects.toThrow(/拒绝发送刷新令牌/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a foreign stored host even when the region claim is valid', async () => {
    const calls: FetchCall[] = []
    stubRefreshExchange(calls)
    await expect(refreshTraeCredential(credential({ host: 'https://evil.example' }))).rejects.toThrow(/拒绝发送刷新令牌/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a host that contradicts the credential claim', async () => {
    const calls: FetchCall[] = []
    stubRefreshExchange(calls)
    await expect(refreshTraeCredential(credential({
      host: 'https://coresg-normal.trae.ai',
      userRegion: 'CN',
    }))).rejects.toThrow(/区域不一致/)
    expect(calls).toHaveLength(0)
  })

  it('refreshes against the canonical gateway when the stored host is empty', async () => {
    const calls: FetchCall[] = []
    stubRefreshExchange(calls)
    const outcome = await refreshTraeCredential(credential({ host: '' }))
    expect(outcome.accessToken).toBe('rotated-access-token')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`https://api.trae.cn${TRAE_SUPERSEDED_EXCHANGE_TOKEN_PATH}`)
    expect(calls[0]?.body).toContain('refresh-token-value')
  })

  it('keeps a validated legacy alias host', async () => {
    const calls: FetchCall[] = []
    stubRefreshExchange(calls)
    await refreshTraeCredential(credential({ host: 'https://www.trae.cn/' }))
    expect(calls[0]?.url).toBe(`https://www.trae.cn${TRAE_SUPERSEDED_EXCHANGE_TOKEN_PATH}`)
  })

  it('uses the international canonical gateway for a host-less SG credential', async () => {
    const calls: FetchCall[] = []
    stubRefreshExchange(calls)
    await refreshTraeCredential(credential({
      host: '',
      userRegion: 'SG',
      edition: 'sg',
    }))
    expect(calls[0]?.url).toBe(`https://growsg-normal.trae.ai${TRAE_SUPERSEDED_EXCHANGE_TOKEN_PATH}`)
  })
})
