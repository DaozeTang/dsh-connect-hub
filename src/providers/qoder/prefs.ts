import type { CheckinLogRow, ProviderId } from '../../shared/contracts.ts'
import type { PrefsStore } from '../../core/prefs.ts'

/**
 * The default automatic check-in moment, in minutes past midnight UTC+8.
 * 10:00 Beijing time is when the daily benefit window opens.
 */
export const DEFAULT_CHECK_IN_MINUTE = 600

/** No automatic check-in may be scheduled before the window opens. */
const EARLIEST_CHECK_IN_MINUTE = DEFAULT_CHECK_IN_MINUTE

const LAST_MINUTE_OF_DAY = 23 * 60 + 59
const LOG_ROW_LIMIT = 30
const LOG_MESSAGE_LIMIT = 300

/** Clamp a stored minute-of-day onto the range the scheduler can honour. */
export function normalizeCheckInMinute(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHECK_IN_MINUTE
  const minute = Math.trunc(value)
  if (minute < 0 || minute > LAST_MINUTE_OF_DAY) return DEFAULT_CHECK_IN_MINUTE
  return Math.max(EARLIEST_CHECK_IN_MINUTE, minute)
}

/** Last check-in attempt, kept per provider so a day can be settled once. */
export interface QoderCheckinRecord {
  /** UTC+8 date the attempt belongs to. */
  date?: string
  status?: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error'
  lastAt?: number
  amount?: number
}

export interface QoderCheckinPrefs {
  enabled: boolean
  /** Minute past midnight, UTC+8, at which the automatic check-in runs. */
  minute: number
  record?: QoderCheckinRecord
  logs: CheckinLogRow[]
}

/** Everything the user configures for this provider; cached state lives elsewhere. */
export interface QoderPrefs {
  /** Model ids switched off in the picker. */
  disabledModels: string[]
  /** Serve each model's largest declared context window. */
  useMaxContext: boolean
  /**
   * Whether the hub may adopt the Qoder desktop app's saved sign-in on its
   * own. Turning it off is what "sign out and stay signed out" means here:
   * the desktop file is untouched, it is simply not imported again.
   */
  autoLogin: boolean
  checkin: QoderCheckinPrefs
}

/** The preference defaults a fresh provider starts from. */
export function defaultPrefs(): QoderPrefs {
  return {
    disabledModels: [],
    useMaxContext: false,
    autoLogin: true,
    checkin: { enabled: false, minute: DEFAULT_CHECK_IN_MINUTE, logs: [] },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isCheckInStatus(value: unknown): value is NonNullable<QoderCheckinRecord['status']> {
  return value === 'claimed' || value === 'already-claimed' || value === 'before-window'
    || value === 'no-campaign' || value === 'error'
}

/** Read the visibility blacklist, de-duplicated and order-preserving. */
function parseDisabledModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return [...new Set(ids)]
}

/** Read one stored log row. */
function parseLogRow(value: unknown): CheckinLogRow | undefined {
  if (!isPlainObject(value)) return undefined
  const at = finiteNumber(value['at'])
  const message = value['message']
  if (at === undefined) return undefined
  if (typeof value['ok'] !== 'boolean') return undefined
  if (typeof message !== 'string') return undefined
  const code = value['code']
  const params = value['params']
  return {
    at,
    ok: value['ok'],
    message: message.slice(0, LOG_MESSAGE_LIMIT),
    ...typeof code === 'string' && code !== '' ? { code } : {},
    ...isPlainObject(params) ? { params: params as Record<string, string | number> } : {},
  }
}

/** Read the last check-in attempt, keeping only fields the status view understands. */
function parseCheckinRecord(value: unknown): QoderCheckinRecord | undefined {
  if (!isPlainObject(value)) return undefined
  const date = typeof value['date'] === 'string' ? value['date'] : undefined
  const status = isCheckInStatus(value['status']) ? value['status'] : undefined
  const lastAt = finiteNumber(value['lastAt'])
  const amount = finiteNumber(value['amount'])
  if (status === undefined && date === undefined && lastAt === undefined) return undefined
  return {
    ...date === undefined ? {} : { date },
    ...status === undefined ? {} : { status },
    ...lastAt === undefined ? {} : { lastAt },
    ...amount === undefined ? {} : { amount },
  }
}

/** Read the whole check-in preference block. */
function parseCheckinPrefs(value: unknown): QoderCheckinPrefs {
  if (!isPlainObject(value)) return { enabled: false, minute: DEFAULT_CHECK_IN_MINUTE, logs: [] }
  const logs = Array.isArray(value['logs'])
    ? value['logs']
      .map(parseLogRow)
      .filter((row): row is CheckinLogRow => row !== undefined)
      .slice(0, LOG_ROW_LIMIT)
    : []
  const record = parseCheckinRecord(value['record'])
  return {
    enabled: value['enabled'] === true,
    minute: normalizeCheckInMinute(value['minute']),
    ...record === undefined ? {} : { record },
    logs,
  }
}

function prefsKey(id: ProviderId): string {
  return `provider:${id}`
}

/** Read one provider's preference document, tolerating missing or malformed data. */
export async function readPrefs(store: PrefsStore, id: ProviderId): Promise<QoderPrefs> {
  const stored = await store.get<unknown>(prefsKey(id))
  if (!isPlainObject(stored)) return defaultPrefs()
  const prefs: QoderPrefs = {
    disabledModels: parseDisabledModels(stored['disabledModels']),
    useMaxContext: stored['useMaxContext'] === true,
    autoLogin: stored['autoLogin'] !== false,
    checkin: parseCheckinPrefs(stored['checkin']),
  }
  return prefs
}

/** Persist one provider's preference document, bounded and JSON-safe. */
export async function writePrefs(store: PrefsStore, id: ProviderId, prefs: QoderPrefs): Promise<void> {
  const document: Record<string, unknown> = {
    disabledModels: prefs.disabledModels,
    useMaxContext: prefs.useMaxContext,
    autoLogin: prefs.autoLogin,
    checkin: {
      enabled: prefs.checkin.enabled,
      minute: prefs.checkin.minute,
      ...prefs.checkin.record === undefined ? {} : { record: prefs.checkin.record },
      logs: prefs.checkin.logs.slice(0, LOG_ROW_LIMIT),
    },
  }
  await store.set(prefsKey(id), document)
}

/** Add one log row to the front, keeping the bounded history and dropping duplicates. */
export function withLogRow(prefs: QoderPrefs, row: CheckinLogRow): QoderPrefs {
  const logs = [row, ...prefs.checkin.logs.filter(entry => entry.at !== row.at)].slice(0, LOG_ROW_LIMIT)
  return { ...prefs, checkin: { ...prefs.checkin, logs } }
}
