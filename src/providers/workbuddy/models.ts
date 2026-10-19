/**
 * Upstream catalog row → hub model view.
 *
 * One hub model carries what the shared UI renders: per-account visibility, the
 * context budget actually served, multiplier, promo badges, input modalities,
 * and the reasoning levels offered. The reasoning judgement mirrors the pi-ai
 * adapter's, so the picker and the settings list cannot disagree.
 */

import type { HubModel, ModelReasoning } from '../../shared/contracts.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyProbeRecord } from './probe-store.ts'
import { normalizeCredits, type WorkBuddyRegion } from './upstream.ts'

/** Accepted multiplier spellings: a bare `x`-prefixed decimal. */
const MULTIPLIER_TEXT = /^x?(\d+(?:\.\d+)?)$/u

/** The free-model badge the hub prepends itself. */
const FREE_BADGE = '免费'

/** The numeric multiplier from a raw credits string (`x0.79` → 0.79). */
export function parseMultiplier(credits: string | undefined): number | undefined {
  const normalized = normalizeCredits(credits)
  const match = normalized === undefined ? null : MULTIPLIER_TEXT.exec(normalized)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** The largest context window the row declares. */
export function maxContextOf(info: WorkBuddyModelInfo): number {
  const alternatives = info.supportedContextWindows
  if (alternatives === undefined || alternatives.length === 0) return info.contextWindow
  return Math.max(info.contextWindow, ...alternatives)
}

/** Reasoning levels the model declares explicitly. */
function declaredLevels(info: WorkBuddyModelInfo): readonly string[] {
  const declared = info.reasoning?.supportedEfforts
  return declared ?? []
}

/**
 * Levels offered for one model: the declared set wins; a validating local probe
 * may supply levels only when the row declares none.
 */
function offeredLevels(info: WorkBuddyModelInfo, observed: WorkBuddyProbeRecord | undefined): string[] {
  const declared = declaredLevels(info)
  if (declared.length > 0) return [...declared]
  if (observed?.validation === 'validating' && observed.efforts.length > 0) return [...observed.efforts]
  return []
}

/**
 * Whether the model can be switched out of thinking. Only a non-empty declared
 * set with `canDisableThinking` qualifies, and the CN endpoint vetoes it on
 * models that declare `onlyReasoning`.
 */
function canDisableThinking(info: WorkBuddyModelInfo, region: WorkBuddyRegion): boolean {
  const reasoning = info.reasoning
  if (reasoning?.canDisableThinking !== true) return false
  if (declaredLevels(info).length === 0) return false
  return region !== 'cn' || reasoning.onlyReasoning !== true
}

/** The default level when it is one of the offered levels. */
function defaultLevel(info: WorkBuddyModelInfo, offered: readonly string[]): string | undefined {
  const candidate = info.reasoning?.defaultEffort
  return candidate !== undefined && offered.includes(candidate) ? candidate : undefined
}

/**
 * Reasoning capability offered for one model, or `null` when the model gets no
 * thinking control at all.
 */
export function reasoningView(
  info: WorkBuddyModelInfo,
  observed: WorkBuddyProbeRecord | undefined,
  region: WorkBuddyRegion,
): ModelReasoning | null {
  if (info.reasoning?.supports !== true) return null
  const offered = offeredLevels(info, observed)
  if (offered.length === 0) return null
  const fallback = defaultLevel(info, offered)
  return {
    supported: offered,
    ...(fallback === undefined ? {} : { default: fallback }),
    canDisable: canDisableThinking(info, region),
  }
}

/** One upstream row as the hub status document describes it. */
export interface HubModelOptions {
  visible: boolean
  useMaxContext: boolean
  observed?: WorkBuddyProbeRecord
  region: WorkBuddyRegion
}

/** Billing multiplier to display: free rows are 0, unknown rows omit the field. */
function displayMultiplier(billing: WorkBuddyModelInfo['billing']): number | undefined {
  if (billing === undefined) return 0
  if (billing.free) return 0
  return parseMultiplier(billing.credits)
}

/** Badges to display, with the free marker prepended when the row is free. */
function displayBadges(billing: WorkBuddyModelInfo['billing']): string[] {
  const badges = [...(billing?.badges ?? [])]
  if (billing?.free === true && !badges.includes(FREE_BADGE)) badges.unshift(FREE_BADGE)
  return badges
}

/** Whether the largest declared window is the one currently selected. */
function maximumWindowSelected(info: WorkBuddyModelInfo, useMaxContext: boolean): boolean {
  if (!useMaxContext) return false
  if ((info.supportedContextWindows?.length ?? 0) === 0) return false
  return maxContextOf(info) > (info.defaultContextWindow ?? info.contextWindow)
}

/** Convert one upstream row (already promotion-adjusted) into a hub model. */
export function toHubModel(info: WorkBuddyModelInfo, options: HubModelOptions): HubModel {
  const multiplier = displayMultiplier(info.billing)
  return {
    id: info.id,
    name: info.name,
    enabled: options.visible,
    ...(multiplier === undefined ? {} : { multiplier }),
    badges: displayBadges(info.billing),
    contextWindow: info.contextWindow,
    maxContextWindow: maxContextOf(info),
    useMaxContext: maximumWindowSelected(info, options.useMaxContext),
    inputs: info.supportsImages ? ['text', 'image'] : ['text'],
    reasoning: reasoningView(info, options.observed, options.region),
  }
}
