/**
 * WorkBuddy model catalog: a built-in roster served until the upstream answer
 * arrives, plus the mutable catalog the shim and the adapter share.
 */

import { modelWithCurrentPromotion } from './upstream.ts'
import type { WorkBuddyUpstreamModel } from './upstream.ts'

/** One model entry the adapter exposes. */
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel

/**
 * Built-in roster for the CN product.
 *
 * Served while the first catalog fetch is in flight, and when that fetch fails
 * entirely. The live fetch replaces it with the day's roster, so this table is a
 * boot-time placeholder, never a promise; its order and metadata follow the
 * service's CLI roster so a signed-in user sees a usable picker immediately.
 *
 * Two deliberate omissions: promotional badges are dynamic, time-boxed console
 * state and must never be baked into a static table; and image capability is
 * stated per row rather than inferred from the model family, because an
 * over-claim admits an attachment the service then rejects.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 960_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.29 credits', free: false } },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.00 credits', free: true } },
  // The service names both this row and `hy3` "Hy3"; a distinct display name is
  // required so the picker never shows two indistinguishable rows. Display only
  // — the wire id stays `hy3-x`.
  { id: 'hy3-x', name: 'Hy3-X', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.05 credits', free: false } },
  { id: 'step-5-preview', name: 'Step-5-Preview', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.00 credits', free: true } },
  { id: 'space-bunny', name: 'Space-Bunny', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'max', canDisableThinking: false }, billing: { credits: 'x0.08 credits', free: false } },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.11 credits', free: false } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'max', canDisableThinking: false }, billing: { credits: 'x0.79 credits', free: false } },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 131_072, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.06 credits', free: false } },
  { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', contextWindow: 1_000_000, maxTokens: 131_072, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.14 credits', free: false } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.79 credits', free: false } },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.79 credits', free: false } },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.71 credits', free: false } },
  { id: 'minimax-m3-pay', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.25 credits', free: false } },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 200_000, maxTokens: 48_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.26 credits', free: false } },
  { id: 'kimi-k3-2', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.62', free: false } },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.77 credits', free: false } },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.57 credits', free: false } },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.52 credits', free: false } },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.51 credits', free: false } },
]

/**
 * Built-in roster for the international product.
 *
 * Same role as {@link FALLBACK_WORKBUDDY_MODELS}: it covers the window before
 * the first successful fetch and an offline start, and it is not a promise
 * about the service's current state. Promotions are time-boxed and therefore
 * never baked into rows.
 */
export const FALLBACK_WORKBUDDY_AI_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, maxTokens: 24_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true }, billing: { free: false } },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.34', free: false } },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.59', free: false } },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, maxTokens: 72_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x3.31', free: false } },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, maxTokens: 24_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true }, billing: { credits: 'x3.33', free: false } },
  { id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 300_000, defaultContextWindow: 300_000, supportedContextWindows: [300_000, 1_000_000], maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { free: false, rateUnknown: true } },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { free: false, rateUnknown: true } },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 300_000, defaultContextWindow: 300_000, supportedContextWindows: [300_000, 1_000_000], maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { free: false, rateUnknown: true } },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 400_000, defaultContextWindow: 400_000, supportedContextWindows: [400_000, 1_000_000], maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x6.67', free: false } },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x3.47', free: false } },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x1.39', free: false } },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x0.14', free: false } },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x3.31', free: false } },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxTokens: 72_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.65', free: false } },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, maxTokens: 72_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.25', free: false } },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, maxTokens: 65_536, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.99', free: false } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.62', free: false } },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.52', free: false } },
]

/** The widest alternative context window a row declares, if any. */
function widestAlternative(info: WorkBuddyModelInfo): number | undefined {
  const alternatives = info.supportedContextWindows
  if (alternatives === undefined || alternatives.length === 0) return undefined
  return Math.max(...alternatives)
}

/**
 * Re-derive one row for the current moment: the promotion is re-evaluated on
 * every read, and the widest declared window replaces the default when the
 * caller asked for it.
 */
function refreshRow(info: WorkBuddyModelInfo, preferMaximumWindow: boolean): WorkBuddyModelInfo {
  const promoted = modelWithCurrentPromotion(info)
  if (!preferMaximumWindow) return promoted
  const widest = widestAlternative(promoted)
  if (widest === undefined || widest <= promoted.contextWindow) return promoted
  return {
    ...promoted,
    defaultContextWindow: promoted.defaultContextWindow ?? promoted.contextWindow,
    contextWindow: widest,
  }
}

/**
 * Mutable catalog shared by the shim's model list and the adapter.
 *
 * Content and visibility are separate concerns: a route with no usable sign-in
 * exposes an empty list (the picker drops an empty group) while staying
 * registered, so a later sign-in needs no restart.
 */
export class WorkBuddyCatalog {
  private entries: readonly WorkBuddyModelInfo[]
  private exposed = true
  private preferMaximumWindow = false

  constructor(initial: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS) {
    this.entries = initial
  }

  /** Current entries; empty while the route has no usable credential. */
  current(): readonly WorkBuddyModelInfo[] {
    if (!this.exposed) return []
    return this.entries.map((info) => refreshRow(info, this.preferMaximumWindow))
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void {
    this.entries = [...models]
  }

  /** Whether this route exposes its models at all. */
  isVisible(): boolean {
    return this.exposed
  }

  /**
   * Show or hide the whole catalog. Returns whether the value changed, so the
   * caller can skip an invalidation that would re-render an identical list.
   */
  setVisible(visible: boolean): boolean {
    if (this.exposed === visible) return false
    this.exposed = visible
    return true
  }

  /** Select the largest declared window where the service offers alternatives. */
  setUseMaximumContextWindow(useMaximum: boolean): boolean {
    if (this.preferMaximumWindow === useMaximum) return false
    this.preferMaximumWindow = useMaximum
    return true
  }

  /** Models to fall back to when a fetch fails; ignores visibility. */
  fallback(): readonly WorkBuddyModelInfo[] {
    return this.entries
  }
}
