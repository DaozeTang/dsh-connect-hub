/**
 * WorkBuddy daily check-in preferences and view mapping.
 *
 * The official desktop app runs a "Buddy" daily check-in activity through the
 * billing service; the hub mirrors the same schedule/claim flow it already
 * implements for Qoder and Trae. All persisted state here is presentation and
 * scheduling data — the claim itself is always decided by the service.
 */

import type { CheckinLogRow, CheckinState, CheckinView } from '../../shared/contracts.ts'
import type { WorkBuddyCheckinActivity } from './upstream.ts'

/** Default daily check-in time, as a UTC+8 minute of day (09:00). */
export const DEFAULT_WORKBUDDY_CHECKIN_MINUTE = 9 * 60
/** Stored check-in log rows kept, newest first. */
export const WORKBUDDY_CHECKIN_LOG_LIMIT = 30
const MINUTE_LIMIT = 24 * 60
const LOG_MESSAGE_LIMIT = 300

/** Persisted check-in state for one WorkBuddy route. */
export interface WorkBuddyCheckinPrefs {
  enabled: boolean
  minute: number
  /** Last claim attempt (successful or not), for the card. */
  lastAttemptAt?: number
  /** Last failed claim time, used to keep a recent error visible. */
  lastErrorAt?: number
  /** UTC+8 date last claimed successfully, e.g. `2026-10-19`. */
  claimedDate?: string
  /** Credits granted by the last successful claim. */
  reward?: number
  /** Newest first. */
  log: CheckinLogRow[]
}

export function defaultWorkBuddyCheckinPrefs(): WorkBuddyCheckinPrefs {
  return { enabled: false, minute: DEFAULT_WORKBUDDY_CHECKIN_MINUTE, log: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function normalizeMinute(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= MINUTE_LIMIT) return undefined
  return value
}

function parseLogRow(value: unknown): CheckinLogRow | undefined {
  if (!isRecord(value)) return undefined
  const at = positiveInteger(value['at'])
  const ok = value['ok']
  const message = value['message']
  if (at === undefined || typeof ok !== 'boolean' || typeof message !== 'string') return undefined
  const code = value['code']
  const params = value['params']
  return {
    at,
    ok,
    message: message.slice(0, LOG_MESSAGE_LIMIT),
    ...typeof code === 'string' && code !== '' ? { code } : {},
    ...isRecord(params) ? { params: params as Record<string, string | number> } : {},
  }
}

/** Tolerant read of the persisted check-in preference document. */
export function parseWorkBuddyCheckinPrefs(value: unknown): WorkBuddyCheckinPrefs {
  if (!isRecord(value)) return defaultWorkBuddyCheckinPrefs()
  const minute = normalizeMinute(value['minute']) ?? DEFAULT_WORKBUDDY_CHECKIN_MINUTE
  const claimedDate = value['claimedDate']
  const reward = value['reward']
  const lastErrorAt = positiveInteger(value['lastErrorAt'])
  const lastAttemptAt = positiveInteger(value['lastAttemptAt'])
  const log = Array.isArray(value['log'])
    ? value['log'].map(parseLogRow).filter((row): row is CheckinLogRow => row !== undefined).slice(0, WORKBUDDY_CHECKIN_LOG_LIMIT)
    : []
  return {
    enabled: value['enabled'] === true,
    minute,
    ...lastAttemptAt === undefined ? {} : { lastAttemptAt },
    ...lastErrorAt === undefined ? {} : { lastErrorAt },
    ...typeof claimedDate === 'string' && claimedDate !== '' ? { claimedDate } : {},
    ...typeof reward === 'number' && Number.isFinite(reward) && reward >= 0 ? { reward } : {},
    log,
  }
}

/** UTC+8 calendar date (`YYYY-MM-DD`) for an instant. */
export function utc8DateOf(atMs: number): string {
  const date = new Date(atMs + 8 * 60 * 60 * 1000)
  return [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
  ].join('-')
}

/** Whether the configured minute has passed on today's UTC+8 clock. */
export function isPastCheckinMinute(minute: number, nowMs: number): boolean {
  const utc8 = new Date(nowMs + 8 * 60 * 60 * 1000)
  return utc8.getUTCHours() * 60 + utc8.getUTCMinutes() >= minute
}

/** Check-in state derived from the activity and the last attempt. */
export function checkinStateOf(
  prefs: WorkBuddyCheckinPrefs,
  activity: WorkBuddyCheckinActivity | undefined,
  hasCredential: boolean,
  nowMs: number,
): CheckinState {
  if (!hasCredential || activity === undefined || !activity.active) return 'unknown'
  if (activity.todayCheckedIn) return 'claimed'
  if (prefs.lastErrorAt !== undefined && utc8DateOf(prefs.lastErrorAt) === utc8DateOf(nowMs)) return 'error'
  return 'available'
}

/** Status view consumed by the existing check-in card. */
export function checkinViewOf(
  prefs: WorkBuddyCheckinPrefs,
  activity: WorkBuddyCheckinActivity | undefined,
  hasCredential: boolean,
  nowMs: number,
): CheckinView {
  const reward = activity?.todayCheckedIn === true
    ? activity.todayCredit
    : prefs.claimedDate === utc8DateOf(nowMs) ? prefs.reward : undefined
  return {
    supported: activity?.active === true,
    enabled: prefs.enabled,
    minute: prefs.minute,
    ...prefs.lastAttemptAt === undefined ? {} : { lastRunAt: prefs.lastAttemptAt },
    state: checkinStateOf(prefs, activity, hasCredential, nowMs),
    ...reward === undefined ? {} : { reward },
    log: prefs.log,
  }
}

/** Append one log row, keeping the newest rows at the front. */
export function withCheckinLog(
  prefs: WorkBuddyCheckinPrefs,
  row: CheckinLogRow,
): WorkBuddyCheckinPrefs {
  return { ...prefs, log: [row, ...prefs.log.filter((entry) => entry.at !== row.at)].slice(0, WORKBUDDY_CHECKIN_LOG_LIMIT) }
}

/** Whether a startup/enable sweep should claim today's reward. */
export function shouldCatchUp(
  prefs: WorkBuddyCheckinPrefs,
  activity: WorkBuddyCheckinActivity | undefined,
  hasCredential: boolean,
  nowMs: number,
): boolean {
  if (!prefs.enabled || !hasCredential) return false
  if (!isPastCheckinMinute(prefs.minute, nowMs)) return false
  if (activity === undefined || !activity.active || activity.todayCheckedIn) return false
  return !(prefs.claimedDate === utc8DateOf(nowMs))
}

/** Normalize a minute-of-day from an action; null when out of range. */
export function normalizeCheckinMinute(value: number): number | null {
  return Number.isInteger(value) && value >= 0 && value < MINUTE_LIMIT ? value : null
}

/** Format a minute of day as `HH:MM`. */
export function formatCheckinMinute(minute: number): string {
  const hours = Math.floor(minute / 60).toString().padStart(2, '0')
  const minutes = (minute % 60).toString().padStart(2, '0')
  return `${hours}:${minutes}`
}
