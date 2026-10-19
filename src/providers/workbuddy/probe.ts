import { randomBytes } from 'node:crypto'
import type { WorkBuddyEffort } from './upstream.ts'

/**
 * Effort spellings a probe sweeps, in order. `minimal` belongs to no service
 * vocabulary; `off` is excluded because disabling thinking is a declared model
 * capability, never something probing may infer.
 */
export const PROBE_EFFORT_CANDIDATES: readonly WorkBuddyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Prompt body every probe sends; it carries nothing user-specific. */
export const PROBE_PROMPT = 'ping'

/** Output ceiling for a probe; the answer is never read. */
export const PROBE_MAX_TOKENS = 1

/** Per-request ceiling so one hung attempt cannot stall the queue. */
export const PROBE_REQUEST_TIMEOUT_MS = 30_000

/** Sentinel generator; injectable so tests get deterministic values. */
export type SentinelFactory = () => string

/** Default sentinel: unmistakably non-canonical, different on every call. */
export function randomSentinel(): string {
  return `probe_sentinel_${randomBytes(12).toString('hex')}`
}

/** One response as the probe sees it. */
export interface ProbeAttempt {
  /** HTTP status, or 0 for a transport failure. */
  status: number
  /** True when a parseable SSE event arrived. */
  streamed: boolean
  /** `extError.code` from a JSON error body, when present. */
  errorCode?: string
  /** Free-form detail for logs; never shown as a capability claim. */
  detail?: string
}

/** How one attempt is performed; the caller owns credentials and HTTP. */
export type ProbeSender = (effort: string | undefined, signal: AbortSignal) => Promise<ProbeAttempt>

/** The outcome of probing one model. */
export type ProbeOutcome =
  | { validation: 'validating'; efforts: readonly WorkBuddyEffort[]; requests: number }
  | { validation: 'non-validating'; efforts: readonly []; requests: number }
  | { validation: 'unknown'; efforts: readonly []; requests: number; reason: string }

/** Which endpoint's rejection vocabulary a probe interprets. */
export type ProbeRegion = 'cn' | 'global'

/**
 * Error codes each endpoint uses for "this effort value is not supported".
 * Measured per endpoint, kept apart so a code only widens detection for the
 * endpoint it was observed on.
 */
const EFFORT_REJECTION_CODES: Record<ProbeRegion, readonly string[]> = {
  cn: ['invalid_reasoning_effort', 'invalid_parameter_value'],
  global: ['invalid_reasoning_effort', 'model_param_invalid', 'invalid_parameter_value'],
}

/** Whether an attempt is an attributable rejection of the effort value. */
function rejectedEffort(attempt: ProbeAttempt, region: ProbeRegion): boolean {
  if (attempt.status !== 400 || attempt.errorCode === undefined) return false
  return EFFORT_REJECTION_CODES[region].includes(attempt.errorCode)
}

/** Whether the attempt proves the service accepted the request and streamed. */
function accepted(attempt: ProbeAttempt): boolean {
  return attempt.status === 200 && attempt.streamed
}

/** Compose a log line for an indecisive attempt. */
function describeUnknown(stage: string, attempt: ProbeAttempt): string {
  const suffixCode = attempt.errorCode === undefined ? '' : ` (${attempt.errorCode})`
  const suffixDetail = attempt.detail === undefined ? '' : `: ${attempt.detail}`
  return `${stage} status ${attempt.status}${suffixCode}${suffixDetail}`
}

/** Options accepted by {@link probeModel}. */
export interface ProbeModelOptions {
  send: ProbeSender
  sentinel?: SentinelFactory
  candidates?: readonly WorkBuddyEffort[]
  timeoutMs?: number
  region?: ProbeRegion
}

/**
 * Probe one model's `reasoning_effort` handling.
 *
 * Three steps, in order: a baseline request proves the request path works; a
 * random sentinel answers whether the service validates the field at all; only
 * after a rejected sentinel are the canonical levels worth sweeping. A model
 * that accepts the sentinel is reported `non-validating` and the sweep stops —
 * every level would otherwise be a false positive.
 */
export async function probeModel(options: ProbeModelOptions): Promise<ProbeOutcome> {
  const makeSentinel = options.sentinel ?? randomSentinel
  const levels = options.candidates ?? PROBE_EFFORT_CANDIDATES
  const timeoutMs = options.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS
  const region = options.region ?? 'cn'
  let requests = 0

  const attemptOnce = async (effort: string | undefined): Promise<ProbeAttempt> => {
    requests += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await options.send(effort, controller.signal)
    } catch (error: unknown) {
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    } finally {
      clearTimeout(timer)
    }
  }

  const baseline = await attemptOnce(undefined)
  if (!accepted(baseline)) {
    return { validation: 'unknown', efforts: [], requests, reason: describeUnknown('baseline', baseline) }
  }

  const sentinel = await attemptOnce(makeSentinel())
  if (accepted(sentinel)) return { validation: 'non-validating', efforts: [], requests }
  if (!rejectedEffort(sentinel, region)) {
    return { validation: 'unknown', efforts: [], requests, reason: describeUnknown('sentinel', sentinel) }
  }

  const verified: WorkBuddyEffort[] = []
  for (const level of levels) {
    const reply = await attemptOnce(level)
    if (accepted(reply)) {
      verified.push(level)
      continue
    }
    if (rejectedEffort(reply, region)) continue
    // A non-decisive answer mid-sweep invalidates the whole finding rather
    // than producing a partial capability claim.
    return { validation: 'unknown', efforts: [], requests, reason: describeUnknown(`level ${level}`, reply) }
  }
  return { validation: 'validating', efforts: verified, requests }
}
