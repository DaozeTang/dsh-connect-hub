/**
 * Trae SOLO chat request timeouts: the shim always supplies a caller signal, so
 * a cancellable response-header deadline is composed with it. A silent peer is
 * abandoned; a long accepted stream is not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { TraeSoloUpstreamClient } from '../../../src/providers/trae/solo.ts'
import type { TraeCredential } from '../../../src/providers/trae/auth.ts'
import type { TraeIdentity } from '../../../src/providers/trae/identity.ts'

const CREDENTIAL: TraeCredential = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  userId: 'user-1',
  host: 'https://api.trae.cn',
  userRegion: 'CN',
  expiresAtMs: Date.now() + 3_600_000,
  refreshExpiresAtMs: Date.now() + 86_400_000,
  edition: 'cn',
  source: 'dsh',
}

const IDENTITY: TraeIdentity = {
  edition: 'cn',
  machineId: 'machine',
  deviceId: 'device',
  platform: 'darwin',
}

const BODY = JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] })

function makeClient(fetchImpl: typeof fetch): TraeSoloUpstreamClient {
  return new TraeSoloUpstreamClient({
    credential: async () => CREDENTIAL,
    identity: async () => IDENTITY,
    fetchImpl,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Trae chat response-header timeout', () => {
  it('aborts a peer that never sends response headers', async () => {
    vi.useFakeTimers()
    let captured: AbortSignal | undefined
    const client = makeClient((async (_input: unknown, init?: RequestInit) => {
      captured = init?.signal as AbortSignal
      return await new Promise<Response>((_resolve, reject) => {
        captured?.addEventListener('abort', () => reject(captured?.reason), { once: true })
      })
    }) as typeof fetch)

    const caller = new AbortController()
    const result = client.chatStream(BODY, caller.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(captured).toBeDefined()
    await vi.advanceTimersByTimeAsync(60_000)
    const settled = await result
    expect(settled.ok).toBe(false)
    expect(captured?.aborted).toBe(true)
  })

  it('clears the header deadline after headers open and still honours caller cancellation', async () => {
    vi.useFakeTimers()
    let captured: AbortSignal | undefined
    const client = makeClient((async (_input: unknown, init?: RequestInit) => {
      captured = init?.signal as AbortSignal
      return new Response('event: output\ndata: {"response":"hi"}\n\n', { status: 200 })
    }) as typeof fetch)

    const caller = new AbortController()
    const result = await client.chatStream(BODY, caller.signal)
    expect(result.ok).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(captured?.aborted).toBe(false)
    caller.abort()
    expect(captured?.aborted).toBe(true)
  })
})
