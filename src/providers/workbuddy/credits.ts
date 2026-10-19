/**
 * Billing answer → credits view.
 *
 * Two answer shapes exist: the personal endpoint's named credit packages, and
 * the CN enterprise endpoint's single cycle quota. The enterprise quota can be
 * uncapped, which is carried as an explicit `unlimited` flag and never as a
 * negative number.
 */

import type { CreditsPackage, CreditsView } from '../../shared/contracts.ts'
import type { WorkBuddyCredits } from './upstream.ts'

/** Fallback display name for the enterprise endpoint's synthetic package. */
const NO_LIMIT_LABEL = '不限额度'

/**
 * Parse the upstream's zone-less date-time string into epoch milliseconds.
 * The string is read in the running machine's local zone, as the desktop app
 * does; a malformed value reads as unknown rather than as a nearby date.
 */
export function parseUpstreamTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text === '') return undefined
  const parsed = Date.parse(text.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Whether the answer is the enterprise cycle quota rather than a package list. */
function enterpriseQuota(credits: WorkBuddyCredits): boolean {
  if (credits.unlimited === true) return true
  if (credits.accounts.length !== 1) return false
  return credits.accounts[0]?.packageName === 'enterprise'
}

/** Render one upstream credit account as a hub package row. */
function toPackage(account: WorkBuddyCredits['accounts'][number], index: number): CreditsPackage {
  return {
    id: `${account.packageName}:${String(index)}`,
    name: account.packageName,
    remaining: account.remain,
    ...(account.size > 0 ? { total: account.size } : {}),
    ...(account.endTimeMs === undefined ? {} : { expiresAt: account.endTimeMs }),
  }
}

/** Sum the capacity of every package that declares one. */
function capacityOf(accounts: WorkBuddyCredits['accounts']): number {
  let total = 0
  for (const account of accounts) {
    if (account.size > 0) total += account.size
  }
  return total
}

/** Convert one upstream billing answer into the hub view. */
export function toCreditsView(credits: WorkBuddyCredits, updatedAt: number, error?: string): CreditsView {
  const unlimited = credits.unlimited === true
  const capacity = capacityOf(credits.accounts)
  const resetAt = parseUpstreamTime(credits.cycleResetTime)
  return {
    kind: enterpriseQuota(credits) ? 'enterprise' : 'credits',
    ...(unlimited ? {} : { remaining: credits.total }),
    ...(capacity > 0 ? { total: capacity } : {}),
    ...(unlimited ? { plan: NO_LIMIT_LABEL } : {}),
    ...(resetAt === undefined ? {} : { resetAt }),
    updatedAt,
    ...(error === undefined ? {} : { error }),
    packages: credits.accounts.map(toPackage),
  }
}

/** A credits view carrying only a fetch failure. */
export function creditsErrorView(error: string, updatedAt: number): CreditsView {
  return { kind: 'credits', updatedAt, error, packages: [] }
}
