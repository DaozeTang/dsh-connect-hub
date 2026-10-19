/**
 * WorkBuddy chat request timeouts: the shim always supplies a caller signal, so
 * the upstream must compose a cancellable response-header deadline instead of
 * relying on `signal ?? timeout` (which never applies when a signal exists).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyUpstreamClient } from '../../../src/providers/workbuddy/upstream.ts'
import type { WorkBuddyCredential } from '../../../src/providers/workbuddy/auth.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

const BODY = JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] })

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => ({ clientVersion: '1.0.0' }) })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WorkBuddy chat response-header timeout', () => {
  it('aborts a peer that accepts the request but never sends headers', async () => {
    vi.useFakeTimers()
    let captured: AbortSignal | undefined
    vi.stubGlobal('fetch', (async (_input: unknown, init?: RequestInit) => {
      captured = init?.signal as AbortSignal
      return await new Promise<Response>((_resolve, reject) => {
        captured?.addEventListener('abort', () => reject(captured?.reason), { once: true })
      })
    }) as typeof fetch)

    const caller = new AbortController()
    const result = client().chatStream(CREDENTIAL, BODY, caller.signal)
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
    vi.stubGlobal('fetch', (async (_input: unknown, init?: RequestInit) => {
      captured = init?.signal as AbortSignal
      return new Response('data: [DONE]\n\n', { status: 200 })
    }) as typeof fetch)

    const caller = new AbortController()
    const result = await client().chatStream(CREDENTIAL, BODY, caller.signal)
    expect(result.ok).toBe(true)
    // A long healthy stream must not be cut by the header timer.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(captured?.aborted).toBe(false)
    // A downstream stop still reaches the upstream request.
    caller.abort()
    expect(captured?.aborted).toBe(true)
  })
})
