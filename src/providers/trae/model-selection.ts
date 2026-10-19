import type { HubModel, ModelReasoning } from '../../shared/contracts.ts'
import { fallbackModelsFor, type TraeModelInfo } from './catalog.ts'
import { effectiveModelEnabled, type TraePrefs } from './prefs.ts'
import type { TraeRegion } from './region.ts'

/** Capacity assumed for a catalog row Trae did not size. */
export const TRAE_FALLBACK_CONTEXT_WINDOW = 200_000

/** Whether DSH should be told this model reads images. */
export function imageCapable(model: Pick<TraeModelInfo, 'multimodal'>): boolean {
  return model.multimodal === true
}

/** Rewrite every row's image capability from Trae's own flag. */
export function withImageCapability(models: readonly TraeModelInfo[]): TraeModelInfo[] {
  return models.map(model => ({
    ...model,
    input: imageCapable(model) ? ['text', 'image'] : ['text'],
  }))
}

interface EffectiveWindows {
  contextWindow: number
  maxContextWindow: number
  useMaxContext: boolean
}

/**
 * Pick the window DSH is told about. The Max tier is only ever used when the
 * model advertises it AND the user opted in; a missing window falls back to the
 * conservative default rather than fabricating a larger one.
 */
export function effectiveContextWindows(
  model: Pick<TraeModelInfo, 'contextWindow' | 'maxContextWindow'>,
  useMaxContext: boolean,
): EffectiveWindows {
  const native = model.contextWindow ?? TRAE_FALLBACK_CONTEXT_WINDOW
  const advertisedMax = model.maxContextWindow
  const canUseMax = useMaxContext && advertisedMax !== undefined && advertisedMax > native
  return {
    contextWindow: canUseMax ? advertisedMax : native,
    maxContextWindow: advertisedMax ?? native,
    useMaxContext: canUseMax,
  }
}

/** Trae's reasoning support as the hub's model reasoning document. */
function reasoningOf(model: TraeModelInfo): ModelReasoning | null {
  const capability = model.reasoning
  if (capability === undefined || capability.supported.length === 0) return null
  return {
    supported: [...capability.supported],
    ...capability.defaultEffort === undefined ? {} : { default: capability.defaultEffort },
    // Trae's wire format has no "off" switch; a supported effort must be sent.
    canDisable: false,
  }
}

/** One catalog row as the hub settings page renders it. */
export function hubModelOf(model: TraeModelInfo, prefs: TraePrefs): HubModel {
  const windows = effectiveContextWindows(model, prefs.useMaxContext)
  const image = imageCapable(model)
  return {
    id: model.id,
    name: model.name,
    enabled: effectiveModelEnabled(prefs, model.id),
    ...model.creditMultiplier === undefined ? {} : { multiplier: model.creditMultiplier },
    // Trae has no promotional labels of its own (unlike WorkBuddy's upstream
    // badges). Its capability flags already render as the localized image and
    // reasoning chips plus the context window, so synthetic tokens such as
    // `max-context` would only duplicate them in the wrong language.
    badges: [],
    contextWindow: windows.contextWindow,
    maxContextWindow: windows.maxContextWindow,
    useMaxContext: windows.useMaxContext,
    inputs: image ? ['text', 'image'] : ['text'],
    reasoning: reasoningOf(model),
  }
}

/**
 * The rows actually served to DSH: image capability applied, then the user's
 * visibility filter. When everything is disabled the region's bootstrap list is
 * served instead, so the route always advertises at least one model.
 */
export function servedModelsOf(
  catalog: readonly TraeModelInfo[],
  prefs: TraePrefs,
  region: TraeRegion,
): TraeModelInfo[] {
  const capable = withImageCapability(catalog)
  const visible = capable.filter(model => effectiveModelEnabled(prefs, model.id))
  const source = visible.length > 0
    ? visible
    : withImageCapability(fallbackModelsFor(region))
  return source.map(model => ({
    ...model,
    contextWindow: effectiveContextWindows(model, prefs.useMaxContext).contextWindow,
  }))
}
