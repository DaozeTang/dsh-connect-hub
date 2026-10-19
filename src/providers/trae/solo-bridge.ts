import { randomUUID } from 'node:crypto'
import { SseDecoder, decodeTraeEvent } from './sse.ts'
import type { TraeCatalog } from './catalog.ts'
import type { TraeChatResult, TraeUpstreamClient, TraeUpstreamErrorKind } from './upstream.ts'

interface OpenAIToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

/**
 * One upstream failure as Trae reports it inside a 200 SSE body: an `error`
 * event, or any event carrying a `code` at or above Trae's error band.
 */
interface TraeFailure {
  code?: number
  message: string
  extra?: unknown
}

/**
 * What Trae's in-stream error codes mean (checked against live CN and global
 * credentials):
 *
 * - `1005` — the model needs a paid plan. Trae answers HTTP 200 with
 *   `event:error {"code":1005,"message":"","extra":"{\"plan\":1}"}`, so the
 *   gate is only visible in `extra.plan`.
 * - `4011` — Trae throttled the SOLO route for this account; its own text says
 *   "rate limit". On CN the different condition `4001` means the function does
 *   not serve the requested `config_name`.
 * - `4008` — the account's SOLO quota is exhausted; distinct from `4011` and
 *   worded by Trae as "exceeded the quota".
 * - `4023` — the model name is unknown on the route that was asked.
 * - `2001` — the upstream has not published its function config for the route
 *   that was asked (an empty directory). This is a transient server-side gap:
 *   wait or retry; it is never a local credential or provider fault.
 */
const TRAE_ERROR_HINTS: Readonly<Record<number, string>> = {
  1005: 'Trae requires a paid plan for this model; the current account\'s plan does not cover it',
  2001: 'Trae has not published its function config for this route (an upstream condition, not a local credential or config problem)',
  4001: 'Trae does not serve this model under the SOLO function the request used (config_name rejected)',
  4008: 'Trae reports the account\'s SOLO quota is exhausted for this request',
  4011: 'Trae throttled the SOLO channel for this account (a rate limit, not the credit balance)',
  4023: 'Trae does not recognise this model name on the SOLO route that was asked',
}

/** `extra` is a JSON *string* on the wire; unwrap it to read `plan`. */
function traeErrorPlan(extra: unknown): number | undefined {
  let value = extra
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown } catch { return undefined }
  }
  if (typeof value !== 'object' || value === null) return undefined
  const plan = (value as Record<string, unknown>)['plan']
  return typeof plan === 'number' ? plan : undefined
}

/** A readable message for an in-stream Trae failure, with its code preserved. */
export function describeTraeFailure(failure: TraeFailure): string {
  const plan = traeErrorPlan(failure.extra)
  const parts = [
    failure.code === undefined ? 'Trae refused the request' : TRAE_ERROR_HINTS[failure.code] ?? 'Trae refused the request',
    ...plan === undefined ? [] : [`plan ${plan}`],
    ...failure.code === undefined ? [] : [`Trae code ${failure.code}`],
  ]
  const detail = failure.message.trim()
  // Trae's own text is appended as detail rather than replacing the hint, so the
  // message carries both the provider's reading of the code and the upstream's own
  // words. It is NOT dropped: the client classifies an error by this text (see
  // classifyTraeFailure), and upstream wording is evidence — showed
  // the provider's own 4011 hint asserting a cause Trae's text contradicted.
  return detail === '' ? parts.join(' · ') : `${parts.join(' · ')} · upstream: ${detail}`
}

/**
 * HTTP status + error kind for an in-stream failure, so the loopback shim can
 * answer with a real error instead of a truncated 200 stream.
 *
 * `1005` is a subscription gate: 402 is what makes clients stop rather than
 * retry, and it is truthful.
 *
 * `4011` is a rate limit and is reported as `429` / `soft_rate`, matching both
 * its own message and pi-ai's text-based classification (`RATE_LIMIT` is
 * retryable). A throttled route is not a route-compatibility problem, so it is
 * never replayed through a fallback path.
 *
 * Everything else stays a client-side rejection.
 */
function classifyTraeFailure(failure: TraeFailure): { status: number; kind: TraeUpstreamErrorKind } {
  if (failure.code === 1005) return { status: 402, kind: 'hard_credit' }
  if (failure.code === 4011) return { status: 429, kind: 'soft_rate' }
  return { status: 400, kind: 'client' }
}

/** Recognise an in-stream failure event, or return undefined for anything else. */
function traeFailureOf(decoded: ReturnType<typeof decodeTraeEvent>): TraeFailure | undefined {
  if (decoded.type !== 'unknown') return undefined
  const payload = decoded.data as Record<string, unknown> | undefined
  const code = typeof payload?.['code'] === 'number' ? payload['code'] : undefined
  if (decoded.event !== 'error' && !(code !== undefined && code >= 4000)) return undefined
  return {
    ...code === undefined ? {} : { code },
    message: typeof payload?.['message'] === 'string' ? payload['message'] : '',
    ...payload?.['extra'] === undefined ? {} : { extra: payload['extra'] },
  }
}

function normalizeToolCalls(value: unknown): OpenAIToolCallDelta[] {
  if (!Array.isArray(value)) return []
  const calls: OpenAIToolCallDelta[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const rawFunction = typeof record['function_call'] === 'object' && record['function_call'] !== null
      ? record['function_call'] as Record<string, unknown>
      : typeof record['function'] === 'object' && record['function'] !== null
        ? record['function'] as Record<string, unknown>
        : {}
    const fn = {
      ...typeof rawFunction['name'] === 'string' ? { name: rawFunction['name'] } : {},
      ...typeof rawFunction['arguments'] === 'string' ? { arguments: rawFunction['arguments'] } : {},
    }
    calls.push({
      index: typeof record['index'] === 'number' ? record['index'] : calls.length,
      ...typeof record['id'] === 'string' ? { id: record['id'] } : {},
      ...record['type'] === 'function' ? { type: 'function' as const } : {},
      ...Object.keys(fn).length === 0 ? {} : { function: fn },
    })
  }
  return calls
}

/** Convert Trae's named SSE events into OpenAI chat-completion SSE chunks. */
function bridgeTraeSource(
  source: ReadableStream<Uint8Array>,
  model: string,
  abort?: AbortController,
): Response {
  const id = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const sse = new SseDecoder()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let sawToolCalls = false
  let emittedFinishReason = false
  let upstreamError: Error | undefined
  let terminalError: Error | undefined
  /** OpenAI chunks enqueued so far; one downstream pull waits for at least one. */
  let enqueued = 0
  /** Set by the stream's cancel algorithm, so an in-flight pull stops writing. */
  let cancelled = false
  // OpenAI-shaped usage object. It is mostly flat counters, but
  // `prompt_tokens_details` nests the cache breakdown, so the value type is
  // widened beyond `number` rather than narrowing the cache fields away.
  let usage: Record<string, number | Record<string, number>> | undefined

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): Uint8Array => encoder.encode(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...usage === undefined ? {} : { usage },
  })}\n\n`)

  const consume = (controller: ReadableStreamDefaultController<Uint8Array>, event: ReturnType<SseDecoder['push']>[number]): void => {
    const decoded = decodeTraeEvent(event)
    if (decoded.type === 'unknown') {
      const failure = traeFailureOf(decoded)
      if (failure !== undefined) {
        // Trae surfaces quota/authorisation failures as an `error` event.
        // Surface it as a real upstream failure instead of letting DSH see
        // a completed-but-empty response (EMPTY_RESPONSE). Codes that arrive
        // before any output are turned into a real HTTP error by
        // {@link bridgeTraeSoloStreamOrFail}, which is the path the bridge
        // actually uses; this arm only covers a failure that interrupts an
        // already-streaming answer.
        upstreamError = new Error(describeTraeFailure(failure))
      }
      return
    }
    if (decoded.type === 'delta') {
      const delta: Record<string, unknown> = {}
      if (decoded.text !== '') delta['content'] = decoded.text
      if (decoded.reasoning !== undefined && decoded.reasoning !== '') delta['reasoning_content'] = decoded.reasoning
      const toolCalls = normalizeToolCalls(decoded.toolCalls)
      if (toolCalls.length > 0) {
        sawToolCalls = true
        delta['tool_calls'] = toolCalls
      }
      if (Object.keys(delta).length > 0) {
        enqueued += 1
        controller.enqueue(chunk(delta))
      }
    } else if (decoded.type === 'usage') {
      // Trae reports cache accounting as `cache_read_input_tokens` /
      // `cache_creation_input_tokens`, a subset of `prompt_tokens` (OpenAI
      // convention). Both are
      // forwarded under the canonical OpenAI spelling, which is what
      // pi-ai's parseChunkUsage reads (`prompt_tokens_details.cached_tokens`
      // / `.cache_write_tokens`); dropping them made every session report
      // "0 cache" even when Trae was serving a warm prefix cache.
      const cacheRead = decoded.cacheReadTokens
      const cacheWrite = decoded.cacheWriteTokens
      const details = {
        ...cacheRead === undefined ? {} : { cached_tokens: cacheRead },
        ...cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite },
      }
      usage = {
        ...decoded.inputTokens === undefined ? {} : { prompt_tokens: decoded.inputTokens },
        ...decoded.outputTokens === undefined ? {} : { completion_tokens: decoded.outputTokens },
        ...decoded.totalTokens === undefined ? {} : { total_tokens: decoded.totalTokens },
        // Omit the details object entirely when Trae sent neither field, so
        // a provider that never reports cache keeps its previous wire shape
        // instead of gaining `prompt_tokens_details: {}`.
        ...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details },
      }
    } else if (decoded.type === 'done') {
      // Trae may send both `event: done` and a trailing `[DONE]`. Emit one
      // OpenAI finish chunk only; pi-ai requires a non-null finish_reason
      // before the stream closes.
      if (!emittedFinishReason) {
        // Mark the terminal state before erroring the controller so the
        // post-loop fallback never enqueues after controller.error().
        emittedFinishReason = true
        if (upstreamError !== undefined) {
          terminalError = upstreamError
          return
        }
        enqueued += 1
        controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : decoded.finishReason || 'stop'))
      }
    }
  }

  const cancelUpstream = async (reason?: unknown): Promise<void> => {
    const current = reader
    reader = undefined
    if (current === undefined) return
    await current.cancel(reason).catch(() => {})
  }

  const stream = new ReadableStream<Uint8Array>({
    // Pull-based forwarding is what makes downstream cancellation and
    // backpressure real: the upstream is read only when the consumer asks for
    // another chunk, so a cancelled "stop" does not drain the whole answer and
    // a slow consumer cannot grow an unbounded queue.
    //
    // One downstream pull may span several wire chunks, because Trae sends
    // events that map to no OpenAI chunk (`request_wait_in_queue`,
    // `progress_notice`, `token_usage`, in-stream `error`). A pull keeps
    // reading until it produces output, reaches a terminal state, or hits EOF;
    // each iteration still reads exactly one wire chunk, so the queue stays
    // bounded by one wire chunk and the backpressure contract is unchanged.
    async pull(controller) {
      if (cancelled) return
      let current: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        while (!cancelled) {
          if (terminalError !== undefined) {
            const error = terminalError
            terminalError = undefined
            await cancelUpstream(error)
            controller.error(error)
            return
          }
          current = reader ?? (reader = source.getReader())
          const next = await current.read()
          // A cancel while the read was in flight owns the stream now: do not
          // enqueue, close or error after the consumer has gone away.
          if (cancelled) return
          if (next.done) {
            for (const event of sse.finish()) consume(controller, event)
            if (cancelled) return
            if (terminalError !== undefined) {
              const error = terminalError
              terminalError = undefined
              await cancelUpstream(error)
              controller.error(error)
              return
            }
            if (upstreamError !== undefined && !emittedFinishReason) {
              const error = upstreamError
              upstreamError = undefined
              await cancelUpstream(error)
              controller.error(error)
              return
            }
            // A clean EOF is a valid Trae termination even when it omits an
            // explicit done event. Synthesize the required OpenAI finish chunk.
            if (!emittedFinishReason) {
              emittedFinishReason = true
              enqueued += 1
              controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : 'stop'))
            }
            enqueued += 1
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
            reader = undefined
            current.releaseLock()
            return
          }
          const before = enqueued
          for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(controller, event)
          if (cancelled) return
          if (terminalError !== undefined) {
            const error = terminalError
            terminalError = undefined
            await cancelUpstream(error)
            controller.error(error)
            return
          }
          // This wire chunk produced at least one OpenAI chunk: return so the
          // consumer applies backpressure before the next read.
          if (enqueued > before) return
          // No output from this chunk (queue/progress/usage/error or a
          // keepalive): read the next wire chunk within the same pull instead
          // of leaving the pending reader.read() unresolved.
        }
      } catch (error) {
        if (cancelled) return
        reader = undefined
        if (current !== undefined) await current.cancel(error).catch(() => {})
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled = true
      // Abort the generation itself, not just the local tee: the caller's
      // signal is what closes the upstream socket and stops billing/CPU.
      abort?.abort(reason)
      await cancelUpstream(reason)
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/**
 * How far {@link openTraeSource} reads before giving up on finding a failure.
 * Trae opens a real answer with small `metadata` / `timing_cost` events, so a
 * healthy stream is recognised well inside these bounds; they exist only so a
 * pathological stream cannot stall the response headers.
 */
const PEEK_MAX_CHUNKS = 64
const PEEK_MAX_BYTES = 262_144

/** Replay the bytes the peek consumed, then drain the rest of the upstream. */
function replayTraeSource(
  buffered: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ended: boolean,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = buffered[index]
      if (chunk !== undefined) {
        index += 1
        controller.enqueue(chunk)
        return
      }
      if (ended) { controller.close(); return }
      const next = await reader.read()
      if (next.done) { controller.close(); return }
      controller.enqueue(next.value)
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}) },
  })
}

/**
 * Open the upstream answer, failing fast when Trae refuses BEFORE producing any
 * output.
 *
 * This exists because Trae reports authorisation and subscription failures
 * inside a **200** SSE body. Relaying that as a 200 and aborting mid-stream
 * loses the code at the HTTP boundary: pi-ai only sees a truncated stream and
 * reports `Stream ended without finish_reason`, which reads as a network fault
 * and is retried five times. Peeking until the first real output lets a refusal
 * become a normal error response with its code and plan intact.
 *
 * The peek is limited to the head of the stream and replayed verbatim, so a
 * healthy answer keeps streaming with no buffering beyond the first event.
 */
async function openTraeSource(response: Response): Promise<
  { ok: true; source: ReadableStream<Uint8Array> } | { ok: false; status: number; kind: TraeUpstreamErrorKind; message: string }
> {
  const body = response.body
  if (body === null) return { ok: false, status: 502, kind: 'server', message: 'Trae upstream returned no response body' }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const sse = new SseDecoder()
  const buffered: Uint8Array[] = []
  let bytes = 0
  let ended = false
  try {
    while (buffered.length < PEEK_MAX_CHUNKS && bytes < PEEK_MAX_BYTES) {
      const next = await reader.read()
      if (next.done) { ended = true; break }
      buffered.push(next.value)
      bytes += next.value.byteLength
      let answered = false
      for (const event of sse.push(decoder.decode(next.value, { stream: true }))) {
        const decoded = decodeTraeEvent(event)
        const failure = traeFailureOf(decoded)
        if (failure !== undefined) {
          await reader.cancel().catch(() => {})
          return { ok: false, ...classifyTraeFailure(failure), message: describeTraeFailure(failure) }
        }
        // Anything Trae itself recognises (`delta`, `usage`, `queue`,
        // `progress`, `done`) means it accepted the request; stop peeking and
        // stream from here.
        if (decoded.type !== 'unknown') answered = true
      }
      if (answered) break
    }
  } catch (error) {
    reader.releaseLock()
    return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
  }
  return { ok: true, source: replayTraeSource(buffered, reader, ended) }
}

/**
 * Bridge an upstream answer, turning an early refusal into a real error result.
 *
 * This is the policy the bridge class uses: it waits for the first upstream
 * signal, turns an early refusal into a real error result, and otherwise hands
 * the response to the synchronous stream converter.
 */
export async function bridgeTraeSoloStreamOrFail(
  response: Response,
  model: string,
  abort?: AbortController,
): Promise<TraeChatResult> {
  const opened = await openTraeSource(response)
  if (!opened.ok) {
    abort?.abort()
    return opened
  }
  return { ok: true, response: bridgeTraeSource(opened.source, model, abort) }
}

/**
 * One resolved wire target: the `config_name` `llm_utils_chat` accepts, plus
 * the directory function that listed it. Trae's roster is split across several
 * SOLO-mode functions and a model is only callable through the one listing it
 * (glm-5.3 answers only under `solo_work_remote`), so the chat call replays it.
 */
export interface TraeWireTarget {
  configName: string
  function?: string
}

/** Resolves a display model id to its wire target (config_name + function). */
export type TraeWireResolver = (displayId: string) => TraeWireTarget | undefined

/** Native SOLO client wrapper used by the loopback OpenAI adapter. */
export class TraeSoloBridge implements TraeUpstreamClient {
  constructor(
    private readonly upstream: TraeUpstreamClient,
    private readonly catalog?: Pick<TraeCatalog, 'current'>,
    private readonly wireResolver?: TraeWireResolver,
  ) {}

  async chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult> {
    // The model id doubles as the SSE chunk label; one model = one id, so the
    // label is exactly what DSH requested. DSH may retain a reasoning selection
    // while switching models: strip that stale option unless this exact model
    // advertises the corresponding wire value.
    let model = 'glm-5.2'
    let prepared = bodyJson
    let changed = false
    try {
      const input = JSON.parse(bodyJson) as Record<string, unknown>
      if (typeof input['model'] === 'string' && input['model'] !== '') model = input['model']
      // Resolve the display model id to the real llm_utils_chat config_name.
      // The Remote directory id may differ from the wire id (e.g. Seed-Code).
      // Prefer the persisted catalog's `wireConfigName` when present, then fall
      // back to the startup wire resolver keyed by display name/id; the resolver
      // never depends on a user-refreshed or re-saved directory.
      const entry = this.catalog?.current().find(item => item.id === model)
      // The catalog row carries both halves once discovery has run; the
      // resolver covers ids that came from elsewhere (startup wire map).
      const fromCatalog = entry?.wireConfigName === undefined
        ? undefined
        : { configName: entry.wireConfigName, ...entry.wireFunction === undefined ? {} : { function: entry.wireFunction } }
      const fromResolver = this.wireResolver?.(model) ?? this.wireResolver?.(entry?.name ?? '')
      const target = fromCatalog ?? fromResolver
      const wireModel = target?.configName ?? model
      const wireFunction = target?.function ?? entry?.wireFunction
      if (wireModel !== input['model']) {
        input['model'] = wireModel
        changed = true
      }
      // Stamp the directory function the model was discovered under, so the
      // upstream is asked through the function that actually lists it.
      if (wireFunction !== undefined && input['function'] !== wireFunction) {
        input['function'] = wireFunction
        changed = true
      }
      if (changed) prepared = JSON.stringify(input)
      if (typeof input['reasoning_effort'] === 'string') {
        const info = entry
        const efforts = info?.reasoningEfforts
        const requested = input['reasoning_effort']
        const mapped = efforts?.[requested as keyof typeof efforts]
        const allowed = efforts === undefined
          ? []
          : Object.values(efforts).filter((value): value is string => typeof value === 'string')
        if (typeof mapped === 'string') input['reasoning_effort'] = mapped
        else if (!allowed.includes(requested)) delete input['reasoning_effort']
        prepared = JSON.stringify(input)
      }
    } catch {
      return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' }
    }
    // One controller owns this generation: the caller's signal aborts it, and
    // a downstream cancel aborts it through the bridge. It is passed to the
    // upstream client so a "stop" reaches the fetch socket, not just the tee.
    const generation = new AbortController()
    const onCallerAbort = (): void => { generation.abort(signal?.reason) }
    if (signal !== undefined) {
      if (signal.aborted) generation.abort(signal.reason)
      else signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    const result = await this.upstream.chatStream(prepared, generation.signal)
    if (!result.ok) {
      signal?.removeEventListener('abort', onCallerAbort)
      return result
    }
    const bridged = await bridgeTraeSoloStreamOrFail(result.response, model, generation)
    if (!bridged.ok) signal?.removeEventListener('abort', onCallerAbort)
    return bridged
  }
}
