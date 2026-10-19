/**
 * Trae SOLO bridge lifecycle: downstream cancellation must abort the upstream
 * generation, and a slow consumer must not drain the upstream into an unbounded
 * queue. Both are deterministic fake streams: no network, no real timers.
 */

import { describe, expect, it } from 'vitest'
import { TraeSoloBridge } from '../../../src/providers/trae/solo-bridge.ts'
import type { TraeChatResult, TraeUpstreamClient } from '../../../src/providers/trae/upstream.ts'

const encoder = new TextEncoder()

function deltaEvent(text: string): string {
  return `event: output\ndata: ${JSON.stringify({ response: text })}\n\n`
}

function doneEvent(): string {
  return 'event: done\ndata: {"finish_reason":"stop"}\n\n'
}

function queueEvent(): string {
  return 'event: request_wait_in_queue\ndata: {"position":3}\n\n'
}

function progressEvent(): string {
  return 'event: progress_notice\ndata: {"stage":"thinking"}\n\n'
}

function usageEvent(total: number): string {
  return `event: token_usage\ndata: {"prompt_tokens":${String(total)},"completion_tokens":1,"total_tokens":${String(total + 1)}}\n\n`
}

function errorEvent(code: number): string {
  return `event: error\ndata: ${JSON.stringify({ code, message: '', extra: '{"plan":1}' })}\n\n`
}

/**
 * Read one bridged chunk or fail fast. The deadline turns a stalled upstream
 * (the regression these tests exist for) into a deterministic failure instead
 * of a test-timeout hang; the timer is always cleared.
 */
async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 500,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`no bridged chunk within ${String(ms)} ms`)) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Drain one bridged response, failing fast on a stall. */
async function readAllWithin(response: Response): Promise<string> {
  return await drainWithin(response.body!.getReader())
}

/** Drain an already-locked reader, failing fast on a stall. */
async function drainWithin(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const next = await readWithin(reader)
    if (next.done) return text
    text += decoder.decode(next.value, { stream: true })
  }
}

interface FakeSource {
  stream: ReadableStream<Uint8Array>
  pulls: () => number
  cancelled: () => boolean
}

/** A pull-driven source that counts reads and records cancellation. */
function fakeSource(chunks: readonly string[]): FakeSource {
  let index = 0
  let pulls = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      const chunk = chunks[index]
      index += 1
      if (chunk === undefined) { controller.close(); return }
      controller.enqueue(encoder.encode(chunk))
    },
    cancel() { cancelled = true },
  })
  return { stream, pulls: () => pulls, cancelled: () => cancelled }
}

function bridgeOver(source: ReadableStream<Uint8Array>, capture?: { signal: AbortSignal | undefined }): TraeSoloBridge {
  const upstream: TraeUpstreamClient = {
    async chatStream(_body: string, signal?: AbortSignal): Promise<TraeChatResult> {
      if (capture !== undefined) capture.signal = signal
      return { ok: true, response: new Response(source, { status: 200 }) }
    },
  }
  return new TraeSoloBridge(upstream)
}

interface GatedSource {
  stream: ReadableStream<Uint8Array>
  pulls: () => number
  cancelled: () => boolean
  /** Resolves once the bridge has started waiting for the gated chunk. */
  waiting: Promise<void>
  release: () => void
}

/**
 * A source that sends one chunk and then leaves the next read pending. The
 * pending read is resolved only by `release()` or by cancellation, which makes
 * "cancel while a pull is waiting upstream" deterministic.
 */
function gatedSource(initial: string): GatedSource {
  let pulls = 0
  let cancelled = false
  let markWaiting: () => void = () => {}
  const waiting = new Promise<void>((resolve) => { markWaiting = resolve })
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulls += 1
      if (pulls === 1) {
        controller.enqueue(encoder.encode(initial))
        return
      }
      markWaiting()
      await gate
      controller.close()
    },
    cancel() {
      cancelled = true
      release()
    },
  })
  return { stream, pulls: () => pulls, cancelled: () => cancelled, waiting, release }
}

describe('TraeSoloBridge streaming lifecycle', () => {
  it('cancels the upstream generation when the downstream reader is cancelled', async () => {
    const events = Array.from({ length: 1_000 }, (_, index) => deltaEvent(`part-${String(index)};`))
    const source = fakeSource(events)
    const capture: { signal: AbortSignal | undefined } = { signal: undefined }
    const bridge = bridgeOver(source.stream, capture)
    const result = await bridge.chatStream(JSON.stringify({ model: 'glm-5.2' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const reader = result.response.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    await reader.cancel('user stopped')

    // The generation itself is aborted (not merely detached)...
    expect(capture.signal?.aborted).toBe(true)
    // ...and the upstream is cancelled without being drained. The header peek
    // plus the source stream's own one-chunk prefetch are the only reads; the
    // other 998 delta events were never pulled.
    expect(source.cancelled()).toBe(true)
    expect(source.pulls()).toBeLessThanOrEqual(3)
  })

  it('does not drain the upstream while the consumer is slow', async () => {
    const events = Array.from({ length: 200 }, (_, index) => deltaEvent(`part-${String(index)};`))
    const source = fakeSource(events)
    const bridge = bridgeOver(source.stream)
    const result = await bridge.chatStream(JSON.stringify({ model: 'glm-5.2' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // No reader has been created yet: only the header peek, the source
    // stream's own single-chunk prefetch and one auto-forward may have run,
    // independent of the 200 queued events.
    await Promise.resolve()
    await Promise.resolve()
    expect(source.pulls()).toBeLessThanOrEqual(3)

    const reader = result.response.body!.getReader()
    await reader.read()
    expect(source.pulls()).toBeLessThanOrEqual(4)
    await reader.cancel()
  })

  it('still forwards a normal answer to the OpenAI chunk shape', async () => {
    const source = fakeSource([deltaEvent('hello'), doneEvent()])
    const bridge = bridgeOver(source.stream)
    const result = await bridge.chatStream(JSON.stringify({ model: 'glm-5.2' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const text = await result.response.text()
    expect(text).toContain('"content":"hello"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('data: [DONE]')
  })

  // A pull that consumes a wire chunk with no OpenAI chunk must keep reading;
  // otherwise the pending read() never resolves (the regression this guards).

  it('yields the first token when queue and progress notices precede output', async () => {
    const source = fakeSource([queueEvent(), progressEvent(), deltaEvent('a'), doneEvent()])
    const bridge = bridgeOver(source.stream)
    const result = await bridge.chatStream(JSON.stringify({ model: 'glm-5.2' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const text = await readAllWithin(result.response)
    expect(text).toContain('"content":"a"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('data: [DONE]')
  })

  it('emits the finish chunk after a usage-only wire chunk', async () => {
    const source = fakeSource([deltaEvent('one'), usageEvent(10), doneEvent()])
    const bridge = bridgeOver(source.stream)
    const result = await bridge.chatStream(JSON.stringify({ model: 'glm-5.2' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const reader = result.response.body!.getReader()
    const first = await readWithin(reader)
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).toContain('"content":"one"')

    const second = await readWithin(reader)
    expect(second.done).toBe(false)
    const finish = new TextDecoder().decode(second.value)
    expect(finish).toContain('"finish_reason":"stop"')
    expect(finish).toContain('"prompt_tokens":10')

    const rest = await drainWithin(reader)
    expect(rest).toContain('data: [DONE]')
  })

  it('rejects the pending read when an error-only wire chunk follows a delta', async () => {
    const source = fakeSource([deltaEvent('one'), errorEvent(1005)])
    const bridge = bridgeOver(source.stream)
    const result = await bridge.chatStream(JSON.stringify({ model: 'glm-5.2' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const reader = result.response.body!.getReader()
    const first = await readWithin(reader)
    expect(first.done).toBe(false)
    // The error event carries no OpenAI chunk; the following read must reach
    // EOF and surface the mapped Trae failure instead of hanging.
    await expect(readWithin(reader)).rejects.toThrow(/paid plan/)
  })

  it('skips empty and keepalive wire chunks without stalling', async () => {
    const source = fakeSource(['', ': keepalive\n\n', deltaEvent('a'), doneEvent()])
    const bridge = bridgeOver(source.stream)
    const result = await bridge.chatStream(JSON.stringify({ model: 'glm-5.2' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const text = await readAllWithin(result.response)
    expect(text).toContain('"content":"a"')
    expect(text).toContain('"finish_reason":"stop"')
  })

  it('cancels cleanly while a pull is waiting for the next upstream chunk', async () => {
    const source = gatedSource(queueEvent())
    const capture: { signal: AbortSignal | undefined } = { signal: undefined }
    const bridge = bridgeOver(source.stream, capture)
    const result = await bridge.chatStream(JSON.stringify({ model: 'glm-5.2' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const reader = result.response.body!.getReader()
    const pending = reader.read()
    // The bridge consumed the queue chunk (no output) and is now waiting for
    // the next wire chunk inside the same pull.
    await source.waiting
    await reader.cancel('user stopped')

    expect(source.cancelled()).toBe(true)
    expect(capture.signal?.aborted).toBe(true)
    // Cancellation resolves the pending read and enqueues nothing.
    await expect(pending).resolves.toMatchObject({ done: true })
  })
})
