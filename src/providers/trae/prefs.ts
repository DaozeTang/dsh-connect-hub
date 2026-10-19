import type { CheckinLogRow, ProbeView } from '../../shared/contracts.ts'
import { TRAE_CHECKIN_LOG_LIMIT, TRAE_DEFAULT_CHECKIN_MINUTE } from './constants.ts'

/**
 * The provider's persisted preferences document.
 *
 * The shape is part of the plugin's stored data contract: keys and value types
 * here must stay compatible with documents written by earlier builds. Parsing
 * is deliberately forgiving — a hand-edited or truncated document degrades to
 * defaults per field instead of throwing.
 */

export const TRAE_PREFS_VERSION = 1

export interface TraeCheckinPrefs {
  enabled: boolean
  /** UTC+8 minute of day the daily claim runs at. */
  minute: number
  lastRunAt?: number
  log: CheckinLogRow[]
}

/** One persisted model-probe verdict. */
export type TraeProbePrefs = Omit<ProbeView, 'modelName'>

export interface TraePrefs {
  version: 1
  /** Selected account for this region; account ids are hashes, never tokens. */
  selectedAccountId?: string
  /** Explicit visibility overrides; a missing id reads as enabled. */
  modelEnabled: Record<string, boolean>
  /** Serve each model's advertised Max window instead of its dev window. */
  useMaxContext: boolean
  /** Whether the user allows quota-spending availability probes. */
  probeConsent: boolean
  /** Last probe verdict per model id. */
  probes: Record<string, TraeProbePrefs>
  checkin: TraeCheckinPrefs
}

const PROBE_STATES: ReadonlySet<string> = new Set(['unknown', 'running', 'ok', 'error', 'inconclusive'])
const MAX_TEXT = 300

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : []
}

function asBooleanMap(value: unknown): Record<string, boolean> {
  const source = asObject(value)
  const result: Record<string, boolean> = {}
  for (const key of Object.keys(source)) {
    if (key !== '' && typeof source[key] === 'boolean') result[key] = source[key] as boolean
  }
  return result
}

function asMinute(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1439
    ? value
    : fallback
}

function asLogRows(value: unknown): CheckinLogRow[] {
  if (!Array.isArray(value)) return []
  const rows: CheckinLogRow[] = []
  for (const entry of value) {
    const row = asObject(entry)
    const at = asPositiveInteger(row['at'])
    const ok = row['ok']
    const message = row['message']
    if (at === undefined || typeof ok !== 'boolean' || typeof message !== 'string') continue
    const code = row['code']
    const params = row['params']
    rows.push({
      at,
      ok,
      message: message.slice(0, MAX_TEXT),
      ...typeof code === 'string' && code !== '' ? { code } : {},
      ...typeof params === 'object' && params !== null ? { params: params as Record<string, string | number> } : {},
    })
  }
  return rows.slice(-TRAE_CHECKIN_LOG_LIMIT)
}

function asProbeMap(value: unknown): Record<string, TraeProbePrefs> {
  const source = asObject(value)
  const probes: Record<string, TraeProbePrefs> = {}
  for (const modelId of Object.keys(source)) {
    if (modelId === '') continue
    const entry = asObject(source[modelId])
    const state = entry['state']
    if (typeof state !== 'string' || !PROBE_STATES.has(state)) continue
    const message = entry['message']
    const at = asPositiveInteger(entry['at'])
    probes[modelId] = {
      modelId,
      state: state as ProbeView['state'],
      efforts: asStringList(entry['efforts']),
      ...typeof message === 'string' && message !== '' ? { message: message.slice(0, MAX_TEXT) } : {},
      ...at === undefined ? {} : { at },
    }
  }
  return probes
}

function asCheckinPrefs(value: unknown): TraeCheckinPrefs {
  const source = asObject(value)
  const lastRunAt = asPositiveInteger(source['lastRunAt'])
  return {
    enabled: source['enabled'] !== false,
    minute: asMinute(source['minute'], TRAE_DEFAULT_CHECKIN_MINUTE),
    ...lastRunAt === undefined ? {} : { lastRunAt },
    log: asLogRows(source['log']),
  }
}

/** A fresh preferences document with every default applied. */
export function defaultTraePrefs(): TraePrefs {
  return {
    version: TRAE_PREFS_VERSION,
    modelEnabled: {},
    useMaxContext: false,
    probeConsent: false,
    probes: {},
    checkin: { enabled: true, minute: TRAE_DEFAULT_CHECKIN_MINUTE, log: [] },
  }
}

/** Tolerant parse of the stored document; never throws on bad data. */
export function parseTraePrefs(value: unknown): TraePrefs {
  const source = asObject(value)
  const selected = source['selectedAccountId']
  return {
    version: TRAE_PREFS_VERSION,
    ...typeof selected === 'string' && selected !== '' ? { selectedAccountId: selected } : {},
    modelEnabled: asBooleanMap(source['modelEnabled']),
    useMaxContext: source['useMaxContext'] === true,
    probeConsent: source['probeConsent'] === true,
    probes: asProbeMap(source['probes']),
    checkin: asCheckinPrefs(source['checkin']),
  }
}

/** Append one check-in log row, keeping the bounded tail. */
export function withCheckinLog(prefs: TraePrefs, row: CheckinLogRow): TraePrefs {
  return {
    ...prefs,
    checkin: {
      ...prefs.checkin,
      log: [...prefs.checkin.log, row].slice(-TRAE_CHECKIN_LOG_LIMIT),
    },
  }
}

/** Model visibility: only an explicit `false` hides a row. */
export function effectiveModelEnabled(prefs: TraePrefs, modelId: string): boolean {
  return prefs.modelEnabled[modelId] ?? true
}

/** Ids of the models this region currently serves, in catalog order. */
export function enabledModelIds(prefs: TraePrefs, catalog: readonly { id: string }[]): string[] {
  return catalog.filter(model => effectiveModelEnabled(prefs, model.id)).map(model => model.id)
}
