import type { TraeDiscoveredModel, TraeDiscoveredReasoning } from './model-metadata.ts'
import type { TraeReasoningEffort } from './reasoning.ts'
import type { TraeReasoningCapability } from './reasoning.ts'
import type { TraeRegion } from './region.ts'

export type TraeInputModality = 'text' | 'image'

/**
 * One model the adapter exposes. `contextWindow` is the effective DSH context
 * after the user's budget; `maxContextWindow` is the native Max window Trae
 * advertises (capability display only — never a second model entry).
 */
export interface TraeModelInfo {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  input?: TraeInputModality[]
  creditMultiplier?: number
  reasoningSupported?: boolean
  reasoning?: TraeDiscoveredReasoning
  reasoningEfforts?: Partial<Record<TraeReasoningEffort, string | null>>
  maxContextWindow?: number
  /** The `config_name` `llm_utils_chat` accepts; absent means `id` is already the wire id. */
  wireConfigName?: string
  /** The directory function this model must be called through (see {@link TraeWireModel.function}). */
  wireFunction?: string
  /**
   * Trae's own `multimodal` flag for this model, carried through from the
   * directory that advertised it. It is the upstream's answer to "does this
   * model read images"; the hub image pass unions it with the user's overrides.
   * user's explicit opt-ins.
   *
   * Deliberately NOT the same thing as `input`: `input` is what DSH is told
   * this route accepts, while this field records what Trae said. Keeping both
   * lets a future refresh re-derive `input` without losing the upstream fact,
   * and lets the card explain WHY a model is image-capable.
   *
   * Absent means the directory did not say (an older `lastCatalog` saved before
   * this field existed, a fallback row, or a directory entry that omitted the
   * key). Absent is treated as false, never as "assume capable": sending an
   * image to a model that cannot read one burns credits for a silent failure.
   */
  multimodal?: boolean
}

/**
 * Bootstrap catalog used before the first live directory is fetched.
 *
 * Every id is a `config_name` that `llm_utils_chat` accepts (the CN roster uses
 * the `-Official` suffix; there is no `auto` entry), because these rows are
 * served verbatim whenever no live directory is available: no install for the
 * region, a signed-out account, or a failed refresh.
 *
 * Every row MUST carry a positive-integer `contextWindow`. DSH rejects a
 * provider whose model cannot be sized (`INVALID_MODEL_CONTEXT`), and that
 * failure is per-provider, so one unsized row would take a whole region
 * offline.
 */
export const FALLBACK_TRAE_MODELS: readonly TraeModelInfo[] = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', contextWindow: 200_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200_000 },
]

/**
 * Bootstrap catalog for the international region. The two rosters barely
 * overlap (the CN list has no Gemini/GPT/MiniMax entries), so an international
 * account must never be seeded with the CN list. These rows are replaced by
 * the first live refresh and require the same positive `contextWindow`.
 */
export const FALLBACK_TRAE_MODELS_AI: readonly TraeModelInfo[] = [
  { id: 'gemini-3.1-pro', name: 'Gemini-3.1-Pro-Preview', contextWindow: 200_000 },
  { id: 'gemini-3-flash-solo', name: 'Gemini-3-Flash-Preview', contextWindow: 200_000 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 200_000 },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 200_000 },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', contextWindow: 200_000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000 },
  { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 272_000 },
]

/**
 * Static fallback directory for a region. The fallback must match the region
 * so an account never shows the other region's roster.
 */
export function fallbackModelsFor(region: TraeRegion): readonly TraeModelInfo[] {
  return region === 'ai' ? FALLBACK_TRAE_MODELS_AI : FALLBACK_TRAE_MODELS
}

/** Exact DSH modalities for one catalog entry; absent metadata is text-only. */
export function traeInputModalities(model: Pick<TraeModelInfo, 'input'>): TraeInputModality[] {
  return [...(model.input ?? ['text'])]
}

/**
 * Compose the DSH-facing model name: Trae's own model picker renders each
 * entry as `Name · x<rate>`, so the credit multiplier is shown inside the
 * name. `TraeModelInfo.name` keeps the pure Trae display name — every join
 * (wire resolution, callable-key filtering) must keep matching the
 * undecorated name; only the model rows handed to DSH (adapter catalog and
 * model discovery) use this decorated name.
 */
export function traeModelDisplayName(model: Pick<TraeModelInfo, 'name' | 'creditMultiplier'>): string {
  return model.creditMultiplier === undefined
    ? model.name
    : `${model.name} · x${model.creditMultiplier.toFixed(2)}`
}

/** One row from `get_detail_param`: the authoritative llm_utils_chat wire id + display name. */
export interface TraeWireModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: TraeReasoningCapability
  /**
   * Effective (post-discount) credit multiplier, read from the row's
   * `display_contact_config` — the figure the Trae IDE renders (see
   * `wireCreditMultiplier` in solo.ts). Wins over the Remote directory's own
   * `consumption_rate`, which reports the undiscounted value.
   */
  creditMultiplier?: number
  /**
   * The `get_detail_param` function this config_name came from. Trae splits its
   * callable roster across several functions (SOLO modes), and a model is only
   * callable through the function that actually lists it — glm-5.3 answers
   * `solo_work_remote` but rejects `solo_work_lite` with 4001. The chat call
   * therefore has to replay the directory's own function.
   */
  function?: string
}

/** Normalise a display name for cross-source joining. */
function displayKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Merge the two Trae model sources into one authoritative catalog.
 *
 * `remote` (the solo.trae.cn `/models` directory) is the authoritative model
 * skeleton: it supplies the display id, display name, context windows, credit
 * multiplier, reasoning and multimodal flags. `wire` (from `get_detail_param`)
 * supplies the real `llm_utils_chat` `config_name` — the only id the chat
 * endpoint actually accepts — plus the authoritative post-discount credit
 * multiplier when `display_contact_config` carries one.
 *
 * A remote row with no wire match is still kept: whether a roster contains a
 * model is ACCOUNT-SCOPED, so an absent wire entry on one account does not
 * prove that another account cannot call it. Such a row ships, and an upstream
 * refusal is translated into a readable error by the bridge (see
 * `describeTraeFailure`), so the user is told why instead of seeing nothing.
 *
 * Credit multiplier precedence: the wire's `display_contact_config` rate wins
 * whenever present (it is the post-discount figure the Trae IDE renders — the
 * Remote directory can report up to 10x the undiscounted value, see
 * `wireCreditMultiplier` in solo.ts); the Remote `consumption_rate` is the
 * fallback when the wire row carries none.
 *
 * Joining is two-tier, in priority order:
 * 1. `wire.id` (the `config_name`) equals the remote id — the model's display
 * id is already its wire id (the common case: glm-5.2,
 * DeepSeek-V4-Flash-Official, kimi-k3, …).
 * 2. `wire.name` (the `display_name`) equals the remote display name — for
 * models whose display id differs from the wire id across Trae versions.
 * When the matched wire `config_name` differs from the remote id it is recorded
 * as `wireConfigName`; otherwise it is left undefined (id is already the wire id).
 */
export function mergeTraeModelSources(
  remote: readonly TraeDiscoveredModel[],
  wire: readonly TraeWireModel[],
): TraeModelInfo[] {
  const wireByName = new Map<string, TraeWireModel>()
  const wireById = new Map<string, TraeWireModel>()
  // First write wins, per map. A wire roster can list one display name across
  // several ids, including a metadata-poor tail row whose `id` and `name` are
  // both the same lower-case string; last-write-wins would let such a row take
  // over the display-name key and rewrite `config_name` to a spelling the
  // upstream rejects (the wire id is the only published `llm_utils_chat`
  // name). Keeping the first row per key leaves the canonical row in place.
  for (const model of wire) {
    if (!wireById.has(displayKey(model.id))) wireById.set(displayKey(model.id), model)
  }
  for (const model of wire) {
    if (!wireByName.has(displayKey(model.name))) wireByName.set(displayKey(model.name), model)
  }
  const result: TraeModelInfo[] = []
  for (const model of remote) {
    const wireModel = wireById.get(displayKey(model.id)) ?? wireByName.get(displayKey(model.name))
    // A row with no wire match still ships (see the note above): the wire lists
    // are account-scoped, so their silence is not proof of uncallability. With
    // no `wireConfigName` the bridge sends the display id and the default
    // function, and an upstream refusal comes back as a readable message
    // rather than a silent absence.
    // The wire rate wins whenever it is present — it is the post-discount
    // figure the Trae IDE renders (`display_contact_config`); the Remote
    // directory's own `consumption_rate` can report up to 10x the undiscounted
    // value under a live promotion (e.g. 0.80 vs the IDE's 0.08).
    const creditMultiplier = wireModel?.creditMultiplier ?? model.creditMultiplier
    result.push({
      id: model.id,
      name: model.name,
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxContextWindow === undefined ? {} : { maxContextWindow: model.maxContextWindow },
      ...creditMultiplier === undefined ? {} : { creditMultiplier },
      input: ['text'],
      // Trae's own answer to "does this model read images". Carried through so
      // the hub image pass can union it with the user's overrides;
      // `input` stays text here and is decided by that single later pass.
      ...model.multimodal === undefined ? {} : { multimodal: model.multimodal },
      reasoningSupported: model.reasoningSupported,
      ...model.reasoning === undefined ? {} : {
        reasoning: model.reasoning,
        reasoningEfforts: Object.fromEntries(model.reasoning.supported.map(effort => [effort, effort === 'low' ? 'light' : effort === 'xhigh' ? 'extra_high' : 'high'])) as Partial<Record<TraeReasoningEffort, string>>,
      },
      ...wireModel !== undefined && wireModel.id !== '' && wireModel.id !== model.id ? { wireConfigName: wireModel.id } : {},
      ...wireModel?.function === undefined ? {} : { wireFunction: wireModel.function },
    })
  }
  return result
}

export class TraeCatalog {
  private models: readonly TraeModelInfo[]
  private visible = true

  /**
   * @param region Seeds the static fallback for this region; each region's
   * provider must never serve the other region's roster before its first live
   * refresh lands.
   */
  constructor(region: TraeRegion = 'cn') {
    this.models = fallbackModelsFor(region)
  }

  /** Served rows: hidden while no account can use them. */
  current(): readonly TraeModelInfo[] {
    return this.visible ? this.models : []
  }

  /**
   * Show or hide the catalog. A route with no usable Trae sign-in serves no
   * rows (matching Qoder/WorkBuddy); the bootstrap roster stays in memory so a
   * signed-in account whose live fetch fails still has something to use.
   * Returns whether the value changed.
   */
  setVisible(visible: boolean): boolean {
    if (this.visible === visible) return false
    this.visible = visible
    return true
  }

  set(models: readonly TraeModelInfo[]): void {
    if (models.length === 0) throw new Error('trae model catalog cannot be empty')
    this.models = models.map(model => ({ ...model, ...model.input === undefined ? {} : { input: [...model.input] } }))
  }
}
