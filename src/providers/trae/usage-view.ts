import type { CheckinState, CheckinView, CreditsPackage, CreditsView } from '../../shared/contracts.ts'
import type { TraeCheckinPrefs } from './prefs.ts'
import type { TraeCheckinClaim, TraeCheckinStatus, TraePayStatus, TraeUsageSnapshot } from './usage.ts'

/**
 * Projections from Trae's usage/check-in answers onto the hub's view documents.
 * The check-in decision helpers are pure so the per-device rule can be pinned
 * without a host: an ACCOUNT-level reward and a DEVICE-level tally are
 * different questions and must never be collapsed.
 */

/** Cached check-in answer for one account, including a read failure reason. */
export interface TraeCheckinSnapshot {
  checkedIn: boolean
  didCheckedIn: boolean
  credits: number
  enabled: boolean
  extraCredits?: number
  readAt: number
  error?: string
}

/** Turn a live check-in answer into the cached snapshot. */
export function checkinSnapshotOf(status: TraeCheckinStatus, now = Date.now()): TraeCheckinSnapshot {
  return {
    checkedIn: status.checkedIn,
    didCheckedIn: status.didCheckedIn,
    credits: status.credits,
    enabled: status.enabled,
    ...status.extraCredits === undefined ? {} : { extraCredits: status.extraCredits },
    readAt: now,
  }
}

/** User-facing check-in state derived from one cached snapshot. */
export function checkinStateOf(snapshot: TraeCheckinSnapshot | undefined): CheckinState {
  if (snapshot === undefined) return 'unknown'
  if (snapshot.error !== undefined) return 'error'
  if (snapshot.checkedIn) return 'claimed'
  if (snapshot.didCheckedIn) return 'device-used'
  return snapshot.enabled ? 'available' : 'unknown'
}

/** What to do with a check-in call once today's status is known. */
export interface TraeCheckinPreflight {
  action: 'claim' | 'skip'
  state: CheckinState
  message: string
  code?: string
}

const DISABLED_MESSAGE = '当前账号未开启签到'
const CLAIMED_MESSAGE = '今日已签到'
const DEVICE_USED_MESSAGE = '本机今日的签到名额可能已被其他账号使用，当前账号今日无法签到'

/**
 * The pre-claim decision. Only the ACCOUNT-level flag may report "already
 * claimed"; a spent DEVICE (possibly for another account) is reported as
 * `device-used` and never sends a claim that can only be refused.
 */
export function checkinPreflight(before: TraeCheckinStatus): TraeCheckinPreflight {
  if (!before.enabled) return { action: 'skip', state: 'unknown', message: DISABLED_MESSAGE, code: 'checkin-disabled' }
  if (before.checkedIn) return { action: 'skip', state: 'claimed', message: CLAIMED_MESSAGE, code: 'checkin-already' }
  if (before.didCheckedIn) return { action: 'skip', state: 'device-used', message: DEVICE_USED_MESSAGE, code: 'checkin-device-used' }
  return { action: 'claim', state: 'available', message: '' }
}

/** The post-claim result; the upstream's device refusal code means device-used. */
export function checkinClaimOutcome(
  claim: TraeCheckinClaim,
  after: TraeCheckinStatus,
  deviceAlreadyClaimedCode: number,
): { state: CheckinState; claimed: boolean; message: string; code?: string, params?: { reward: number } } {
  if (claim.claimed) {
    return {
      state: 'claimed',
      claimed: true,
      message: `签到成功，获得 ${String(after.credits)} 积分`,
      code: 'checkin-claimed',
      params: { reward: after.credits },
    }
  }
  if (claim.code === deviceAlreadyClaimedCode) {
    return {
      state: 'device-used',
      claimed: false,
      message: '本机今日的签到名额可能已被其他账号使用，当前账号今日无法签到',
      code: 'checkin-device-used',
    }
  }
  return {
    state: checkinStateOf(checkinSnapshotOf(after)),
    claimed: false,
    message: claim.message === '' ? '签到失败，请稍后重试' : `签到失败：${claim.message}`,
    code: 'checkin-failed',
  }
}

/** Trae reports fractional multipliers; the UI shows four decimal places. */
function precise(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function remainingOf(limit: number | undefined, consumed: number | undefined): number {
  return precise(Math.max(0, (limit ?? 0) - (consumed ?? 0)))
}

function creditPackOf(pack: TraeUsageSnapshot['packs'][number]): CreditsPackage {
  return {
    id: pack.entitlementId !== '' ? pack.entitlementId : pack.displayDesc,
    ...pack.displayDesc === '' ? {} : { name: pack.displayDesc },
    remaining: remainingOf(pack.creditsLimit, pack.consumedCredits),
    ...pack.creditsLimit === undefined ? {} : { total: pack.creditsLimit },
    ...pack.endTimeMs !== undefined && pack.endTimeMs > 0 ? { expiresAt: pack.endTimeMs } : {},
  }
}

/** Project the domestic credit snapshot into the hub's credit view. */
export function creditsViewOfSnapshot(snapshot: TraeUsageSnapshot, now = Date.now()): CreditsView {
  const { totalAmount, consumedAmount } = snapshot.summary
  return {
    kind: 'credits',
    remaining: precise(totalAmount - consumedAmount),
    total: totalAmount,
    updatedAt: now,
    packages: snapshot.packs.map(creditPackOf),
  }
}

/** Project the international subscription answer (no credit packs exist there). */
export function creditsViewOfPayStatus(status: TraePayStatus, now = Date.now()): CreditsView {
  const plan = status.payIdentityStr
  return {
    kind: 'subscription',
    ...plan === undefined || plan === '' ? {} : { plan },
    updatedAt: now,
    packages: [],
  }
}

/** Merge the cached upstream answer with the user's schedule and log. */
export function checkinViewOf(snapshot: TraeCheckinSnapshot | undefined, prefs: TraeCheckinPrefs): CheckinView {
  const reward = snapshot === undefined ? 0 : snapshot.credits + (snapshot.extraCredits ?? 0)
  return {
    supported: true,
    enabled: prefs.enabled && (snapshot?.enabled ?? true),
    minute: prefs.minute,
    ...prefs.lastRunAt === undefined ? {} : { lastRunAt: prefs.lastRunAt },
    state: checkinStateOf(snapshot),
    ...reward <= 0 ? {} : { reward },
    log: prefs.log.map(row => ({ ...row })),
  }
}
