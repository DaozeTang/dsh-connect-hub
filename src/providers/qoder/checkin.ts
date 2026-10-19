import type { CheckinLogRow, CheckinState, CheckinView } from '../../shared/contracts.ts'
import { redactText } from '../../core/redact.ts'
import type { QoderCheckInResult } from './qoder/transport/checkin.ts'
import { formatUtc8Date, utc8WallClock } from './utc8.ts'
import {
  normalizeCheckInMinute,
  withLogRow,
  type QoderCheckinPrefs,
  type QoderPrefs,
} from './prefs.ts'

export { DEFAULT_CHECK_IN_MINUTE, normalizeCheckInMinute } from './prefs.ts'

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000
const DETAIL_LIMIT = 160

type CheckInStatus = NonNullable<QoderPrefs['checkin']['record']>['status']

function isClaimed(status: CheckInStatus): boolean {
  return status === 'claimed' || status === 'already-claimed'
}

/** Minutes elapsed since UTC+8 midnight for an instant. */
function minuteOfUtc8Day(atMs: number): number {
  const clock = utc8WallClock(atMs)
  return clock.getHours() * 60 + clock.getMinutes()
}

/** Whether the configured check-in moment has already passed on the UTC+8 clock. */
export function isPastCheckInTime(minuteOfDay: number, nowMs: number = Date.now()): boolean {
  return minuteOfUtc8Day(nowMs) >= normalizeCheckInMinute(minuteOfDay)
}

/** Whether today's benefit has already been settled for this provider. */
export function settledToday(checkin: QoderCheckinPrefs, nowMs: number = Date.now()): boolean {
  const record = checkin.record
  if (record === undefined) return false
  return record.date === formatUtc8Date(nowMs) && record.status !== undefined && isClaimed(record.status)
}

/**
 * Whether a startup or credential-adoption sweep should claim today's benefit.
 *
 * Only a real claim settles the day. `no-campaign`, `before-window` and `error`
 * remain retryable, so an early failure never burns the day's chance.
 */
export function shouldCatchUp(checkin: QoderCheckinPrefs, nowMs: number = Date.now()): boolean {
  if (!checkin.enabled) return false
  if (!isPastCheckInTime(checkin.minute, nowMs)) return false
  return !settledToday(checkin, nowMs)
}

function claimedMessage(amount: number | undefined): string {
  return amount === undefined ? '签到成功' : `签到成功，获得 ${amount} 积分`
}

function failureMessage(message: string | undefined): string {
  if (message === undefined || message.trim() === '') return '签到失败，请稍后重试'
  return `签到失败：${redactText(message).slice(0, DETAIL_LIMIT)}`
}

/** The user-facing summary of one check-in attempt. */
export function checkinMessage(result: QoderCheckInResult): string {
  if (result.status === 'claimed') return claimedMessage(result.amount)
  if (result.status === 'already-claimed') return '今日已签到'
  if (result.status === 'before-window') return '签到窗口尚未开放，请稍后再试'
  if (result.status === 'no-campaign') return '当前区域暂无可领取的签到活动'
  return failureMessage(result.message)
}

/** Stable message code and params for one attempt (the client localizes it). */
export function checkinMessageCode(result: QoderCheckInResult): { code: string, params?: { reward: number } } {
  if (result.status === 'claimed') {
    return result.amount === undefined
      ? { code: 'checkin-claimed-plain' }
      : { code: 'checkin-claimed', params: { reward: result.amount } }
  }
  if (result.status === 'already-claimed') return { code: 'checkin-already' }
  if (result.status === 'before-window') return { code: 'checkin-window-closed' }
  if (result.status === 'no-campaign') return { code: 'checkin-no-campaign' }
  return { code: 'checkin-failed' }
}

/** One attempt expressed as the contract's log row. */
export function checkinLogRow(result: QoderCheckInResult): CheckinLogRow {
  const message = checkinMessage(result)
  if (result.status === 'error') {
    const prefix = '签到失败：'
    const reason = message.startsWith(prefix) ? message.slice(prefix.length) : undefined
    return {
      at: result.timestamp,
      ok: false,
      message,
      ...reason === undefined
        ? { code: 'checkin-failed' }
        : { code: 'checkin-failed-reason', params: { reason } },
    }
  }
  return {
    at: result.timestamp,
    ok: result.status === 'claimed' || result.status === 'already-claimed',
    message,
    ...checkinMessageCode(result),
  }
}

/** Fold one check-in attempt into the provider preferences. */
export function applyCheckinResult(prefs: QoderPrefs, result: QoderCheckInResult): QoderPrefs {
  const withRecord: QoderPrefs = {
    ...prefs,
    checkin: {
      ...prefs.checkin,
      record: {
        date: result.date,
        status: result.status,
        lastAt: result.timestamp,
        ...result.amount === undefined ? {} : { amount: result.amount },
      },
    },
  }
  return withLogRow(withRecord, checkinLogRow(result))
}

/** Whether a stored record belongs to the UTC+8 day containing `atMs`. */
function recordCoversDay(prefs: QoderPrefs, atMs: number): boolean {
  return prefs.checkin.record?.date === formatUtc8Date(atMs)
}

/** Whether a failed attempt is recent enough to keep showing as an error. */
function recentFailure(prefs: QoderPrefs, nowMs: number): boolean {
  const record = prefs.checkin.record
  if (record?.status !== 'error' || record.lastAt === undefined) return false
  return nowMs - record.lastAt < MILLIS_PER_DAY
}

/** The contract check-in state derived from the last attempt and the credential. */
export function checkinStateOf(prefs: QoderPrefs, hasCredential: boolean, nowMs: number = Date.now()): CheckinState {
  if (!hasCredential) return 'unknown'
  const record = prefs.checkin.record
  if (record === undefined) return 'available'
  if (recordCoversDay(prefs, nowMs)) {
    if (record.status === undefined) return 'available'
    if (isClaimed(record.status)) return 'claimed'
    return record.status === 'error' ? 'error' : 'available'
  }
  return recentFailure(prefs, nowMs) ? 'error' : 'available'
}

/** The status document's check-in view for this provider. */
export function checkinViewOf(prefs: QoderPrefs, hasCredential: boolean, nowMs: number = Date.now()): CheckinView {
  const record = prefs.checkin.record
  return {
    supported: true,
    enabled: prefs.checkin.enabled,
    minute: prefs.checkin.minute,
    ...record?.lastAt === undefined ? {} : { lastRunAt: record.lastAt },
    state: checkinStateOf(prefs, hasCredential, nowMs),
    ...record?.amount === undefined ? {} : { reward: record.amount },
    log: prefs.checkin.logs,
  }
}
