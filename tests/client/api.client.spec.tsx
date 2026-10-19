/** Hub API client: timeout cleanup, action budgets and the 401 retry. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionTimeoutMs, fetchStatus } from '../../src/client/api.ts'

const STATUS = {
  version: '0.0.0-test',
  revision: 0,
  now: 1,
  key: 'hub-key',
  warnings: [],
  providers: [],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('hub API client', () => {
  it('clears the abort timer after a successful read', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => json(STATUS)))
    await fetchStatus()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a status read that never settles', async () => {
    vi.useFakeTimers()
    let captured: AbortSignal | undefined
    vi.stubGlobal('fetch', (async (_input: unknown, init?: RequestInit) => {
      captured = init?.signal as AbortSignal
      return await new Promise<Response>((_resolve, reject) => {
        captured?.addEventListener('abort', () => reject(captured?.reason), { once: true })
      })
    }) as typeof fetch)
    const pending = fetchStatus()
    // Attach the rejection expectation before flushing the timer so the
    // deliberate abort is never reported as an unhandled rejection.
    const rejected = expect(pending).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    expect(captured?.aborted).toBe(true)
  })

  it('gives slow refresh actions a longer budget than ordinary actions', () => {
    expect(actionTimeoutMs({ type: 'refresh-status' })).toBe(120_000)
    expect(actionTimeoutMs({ type: 'refresh-catalog', provider: 'qoder' })).toBe(120_000)
    expect(actionTimeoutMs({ type: 'refresh-usage', provider: 'qoder' })).toBe(120_000)
    expect(actionTimeoutMs({ type: 'save-secret', provider: 'qoder', secret: 'x' })).toBe(20_000)
    expect(actionTimeoutMs({ type: 'set-max-context', provider: 'qoder', useMax: true })).toBe(20_000)
  })

  it('re-reads the status key and retries a 401 action once', async () => {
    // Fresh module instance: the cached hub key must be absent for this test.
    vi.resetModules()
    const { runAction: freshRunAction } = await import('../../src/client/api.ts')
    const urls: string[] = []
    let actionCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/status')) return json(STATUS)
      actionCalls += 1
      if (actionCalls === 1) return json({ error: 'unauthorized' }, 401)
      return json({ ok: true, status: STATUS })
    }))
    const result = await freshRunAction({ type: 'refresh-usage', provider: 'qoder' })
    expect(result.ok).toBe(true)
    expect(actionCalls).toBe(2)
    expect(urls.filter(url => url.endsWith('/status'))).toHaveLength(2)
  })
})
