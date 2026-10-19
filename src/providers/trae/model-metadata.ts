import type { TraeReasoningEffort } from './reasoning.ts'

export interface TraeDiscoveredReasoning {
  supported: TraeReasoningEffort[]
  defaultEffort?: TraeReasoningEffort
}

/** One model row as the remote directory advertises it. */
export interface TraeDiscoveredModel {
  id: string
  name: string
  multimodal: boolean
  contextWindow?: number
  maxContextWindow?: number
  creditMultiplier?: number
  reasoningSupported: boolean
  reasoning?: TraeDiscoveredReasoning
}

/** Directory effort names mapped onto the provider's effort vocabulary. */
const EFFORT_ALIASES: Readonly<Record<string, TraeReasoningEffort>> = {
  light: 'low',
  high: 'high',
  extra_high: 'xhigh',
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** `features` arrives as a JSON string holding a second document. */
function decodeFeatures(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return asObject(JSON.parse(value) as unknown)
  } catch {
    return undefined
  }
}

function decodeEffort(alias: unknown): TraeReasoningEffort | undefined {
  return typeof alias === 'string' ? EFFORT_ALIASES[alias] : undefined
}

function decodeReasoning(
  features: Record<string, unknown> | undefined,
  config: Record<string, unknown> | undefined,
): { supported: boolean; reasoning?: TraeDiscoveredReasoning } {
  const feature = asObject(features?.['reasoning'])
  const supportedFeature = feature?.['enable'] === true
  const listed = config?.['options']
  const supported: TraeReasoningEffort[] = []
  if (Array.isArray(listed)) {
    for (const alias of listed) {
      const effort = decodeEffort(alias)
      if (effort !== undefined) supported.push(effort)
    }
  }
  const requestedDefault = decodeEffort(config?.['default_level'])
  const defaultEffort = requestedDefault !== undefined && supported.includes(requestedDefault)
    ? requestedDefault
    : undefined
  if (supported.length === 0) return { supported: supportedFeature }
  return {
    supported: supportedFeature,
    reasoning: defaultEffort === undefined ? { supported } : { supported, defaultEffort },
  }
}

/**
 * Normalize one remote-directory model row.
 *
 * Only facts the endpoint explicitly advertised are carried: an absent window,
 * multiplier or reasoning block stays absent rather than being defaulted.
 */
export function parseTraeRemoteModel(value: unknown): TraeDiscoveredModel | undefined {
  const row = asObject(value)
  if (row === undefined) return undefined
  const id = row['name']
  if (typeof id !== 'string' || id === '') return undefined
  const displayName = row['display_name']
  const windows = asObject(row['context_window_tokens'])
  const dev = positiveNumber(windows?.['dev'])
  const max = row['max_mode'] === true ? positiveNumber(windows?.['max']) : undefined
  const features = decodeFeatures(row['features'])
  const consumption = asObject(features?.['consumption_rate'])
  const consumptionData = asObject(consumption?.['data'])
  const creditMultiplier = consumption?.['enable'] === true
    ? positiveNumber(consumptionData?.['rate'])
    : undefined
  const reasoningConfig = asObject(row['reasoning_effort_config'])
  const reasoning = decodeReasoning(features, reasoningConfig)
  return {
    id,
    name: typeof displayName === 'string' && displayName !== '' ? displayName : id,
    multimodal: row['multimodal'] === true,
    ...dev === undefined ? {} : { contextWindow: dev },
    ...max === undefined ? {} : { maxContextWindow: max },
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    reasoningSupported: reasoning.supported,
    ...reasoning.reasoning === undefined ? {} : { reasoning: reasoning.reasoning },
  }
}
