import { describe, expect, it, vi } from 'vitest'
import {
  classifyProbeError,
  classifyProbeResult,
  probeOneModel,
  probeModelsSequentially,
  TRAE_PROBE_TIMEOUT_MS,
} from '../../../src/providers/trae/model-probe.ts'
import type { TraeChatResult } from '../../../src/providers/trae/upstream.ts'

function bridgedResponse(content = 'pong'): Response {
  return new Response(
    `data: {"choices":[{"index":0,"delta":{"content":"${content}"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

describe('classifyProbeResult', () => {
  it('reports an answer with output as available', () => {
    expect(classifyProbeResult({ ok: true, response: new Response('') }, true))
      .toEqual({ verdict: 'available', detail: 'upstream answered' })
  })

  it('treats a stream that carried no output as inconclusive, not unavailable', () => {
    expect(classifyProbeResult({ ok: true, response: new Response('') }, false).verdict).toBe('unknown')
  })

  it('reads the subscription gate out of the translated message', () => {
    const classified = classifyProbeResult({
      ok: false,
      status: 402,
      kind: 'hard_credit',
      message: "Trae requires a paid plan for this model · plan 4 · Trae code 1005",
    }, false)
    expect(classified.verdict).toBe('gated')
  })

  it('reads 4001 as the only verdict allowed to call a model unusable', () => {
    expect(classifyProbeResult({
      ok: false,
      status: 400,
      kind: 'client',
      message: 'Trae does not serve this model under the SOLO function the request used · Trae code 4001',
    }, false).verdict).toBe('unsupported')
  })

  it('reports 4011 as throttled, never as a dead model', () => {
    expect(classifyProbeResult({
      ok: false,
      status: 429,
      kind: 'soft_rate',
      message: 'Trae throttled the SOLO channel for this account · Trae code 4011',
    }, false).verdict).toBe('rate_limited')
  })

  it('keeps an exhausted account quota inconclusive about the model', () => {
    expect(classifyProbeResult({
      ok: false,
      status: 400,
      kind: 'client',
      message: "Trae reports the account's SOLO quota is exhausted · Trae code 4008",
    }, false).verdict).toBe('unknown')
  })

  it('treats an unauthenticated answer as an auth stop', () => {
    expect(classifyProbeResult({ ok: false, status: 401, kind: 'authentication', message: 'token rejected' }, false).verdict).toBe('auth')
  })

  it('never turns a transport failure or a server fault into a negative verdict', () => {
    expect(classifyProbeResult({ ok: false, status: 0, kind: 'server', message: 'transport error: socket hang up' }, false).verdict).toBe('unknown')
    expect(classifyProbeResult({ ok: false, status: 500, kind: 'server', message: 'HTTP 500' }, false).verdict).toBe('unknown')
  })

  it('classifies a stream error by its named code, otherwise unknown', () => {
    expect(classifyProbeError('Trae throttled the SOLO channel · Trae code 4011').verdict).toBe('rate_limited')
    expect(classifyProbeError('socket hang up').verdict).toBe('unknown')
    expect(classifyProbeError('').detail).toContain('without a message')
  })
})

describe('probeOneModel', () => {
  it('reports a forwarded answer as available', async () => {
    const result = await probeOneModel(async () => ({ ok: true, response: bridgedResponse() }), 'glm-5.2')
    expect(result).toMatchObject({ id: 'glm-5.2', verdict: 'available' })
  })

  it('reports a timeout as not determined rather than unusable', async () => {
    const neverAnswers = (_body: string, signal?: AbortSignal): Promise<TraeChatResult> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const result = await probeOneModel(neverAnswers, 'glm-5.2', 10)
    expect(result.verdict).toBe('unknown')
    expect(result.detail).toContain('no answer within')
    expect(TRAE_PROBE_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

describe('probeModelsSequentially', () => {
  it('stops after an auth failure because every later probe would repeat it', async () => {
    const calls: string[] = []
    const results = await probeModelsSequentially(async body => {
      const model = (JSON.parse(body) as { model: string }).model
      calls.push(model)
      if (model === 'b') return { ok: false, status: 401, kind: 'authentication', message: 'rejected' }
      return { ok: true, response: bridgedResponse() }
    }, ['a', 'b', 'c'])
    expect(calls).toEqual(['a', 'b'])
    expect(results.map(result => result.verdict)).toEqual(['available', 'auth'])
  })

  it('probes one at a time so a burst cannot manufacture throttling', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = probeModelsSequentially(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight -= 1
      return { ok: true, response: bridgedResponse() }
    }, ['a', 'b', 'c'])
    // The first probe is held open; a concurrent implementation would already
    // have started the second by the time this observes inFlight.
    await vi.waitFor(() => { expect(inFlight).toBe(1) })
    expect(maxInFlight).toBe(1)
    release()
    await run
    expect(maxInFlight).toBe(1)
  })
})
