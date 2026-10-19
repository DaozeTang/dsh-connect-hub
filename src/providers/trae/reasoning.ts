/**
 * Trae's reasoning-effort vocabulary and the parser for the capability block
 * its directory advertises. Only levels Trae itself lists are ever forwarded;
 * the provider never invents an effort for a model.
 */

/** Effort levels, ordered from least to most reasoning work. */
export const TRAE_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

export type TraeReasoningEffort = typeof TRAE_REASONING_EFFORTS[number]

export interface TraeReasoningCapability {
  supported: readonly TraeReasoningEffort[]
  defaultEffort?: TraeReasoningEffort
}

const EFFORT_LOOKUP: ReadonlySet<string> = new Set(TRAE_REASONING_EFFORTS)

function effortOf(value: unknown): TraeReasoningEffort | undefined {
  return typeof value === 'string' && EFFORT_LOOKUP.has(value)
    ? value as TraeReasoningEffort
    : undefined
}

/**
 * Read `reasoning_effort_options` / `default_reasoning_effort` from one model
 * row. Unknown spellings are dropped, and a default that is not itself in the
 * supported list is dropped too rather than exposed.
 */
export function parseReasoningCapability(value: unknown): TraeReasoningCapability | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const options = source['reasoning_effort_options']
  const supported: TraeReasoningEffort[] = []
  if (Array.isArray(options)) {
    for (const option of options) {
      const effort = effortOf(option)
      if (effort !== undefined) supported.push(effort)
    }
  }
  const requestedDefault = effortOf(source['default_reasoning_effort'])
  const defaultEffort = requestedDefault !== undefined && supported.includes(requestedDefault)
    ? requestedDefault
    : undefined
  if (supported.length === 0) return undefined
  return defaultEffort === undefined ? { supported } : { supported, defaultEffort }
}
