/**
 * Model vocabulary and catalog state for the Qoder provider.
 *
 * These row types are what the provider stores, the adapter serves and the
 * status document renders. The service-side discovery shape is translated into
 * them by the upstream client.
 */

export interface QoderModelInfo {
  id: string
  name: string
  /** Effective input budget in tokens. */
  contextWindow: number
  /** The service's preferred window before a larger one is selected. */
  defaultContextWindow?: number
  /** Selectable window sizes the service declares, ascending. */
  supportedContextWindows?: readonly number[]
  /** Per-request output cap. */
  maxTokens: number
  /** Whether the model accepts image input. */
  supportsImages: boolean
  /** Reasoning metadata; absent when the service declared none. */
  reasoning?: QoderModelReasoning
  billing: QoderModelBilling
  /** Origin marker the service reports (`system` / `user`), when present. */
  source?: string
}

/** What the service declares about one model's reasoning. */
export interface QoderModelReasoning {
  supports: boolean
  /** Effort ids the model advertises, in canonical order. */
  supportedEfforts?: readonly string[]
  /** The model's default effort id, when the service names one. */
  defaultEffort?: string
  /** Whether thinking can be switched off. */
  canDisableThinking: boolean
}

/** The price the catalog reports for one model. */
export interface QoderModelBilling {
  /** Rate label, spelled `x<n>` (a multiplier on the base rate). */
  credits?: string
  /** Whether the model is free; only the `x0` marker sets this. */
  free: boolean
  /** The service disclosed no rate; the UI says so explicitly. */
  rateUnknown?: boolean
}

const DEFAULT_MAX_TOKENS = 32_768

/** Build one entry for the built-in roster. */
function fallbackModel(
  id: string,
  name: string,
  contextWindow: number,
  supportsImages: boolean,
): QoderModelInfo {
  return {
    id,
    name,
    contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
    supportsImages,
    billing: { free: false, rateUnknown: true },
    source: 'system',
  }
}

/**
 * The models both regions can serve before the first live directory arrives.
 *
 * This is a starting point, not a claim about the current service: a successful
 * discovery replaces it at startup. A row here carries no reasoning or rate
 * metadata, so it offers no thinking control until the live list says otherwise.
 */
export const FALLBACK_QODER_MODELS: readonly QoderModelInfo[] = [
  fallbackModel('cmodel', 'Cantus (Qoder)', 1_000_000, true),
  fallbackModel('auto', 'Qoder Auto', 180_000, true),
  fallbackModel('ultimate', 'Qoder Ultimate', 1_000_000, true),
  fallbackModel('performance', 'Qoder Performance', 1_000_000, true),
  fallbackModel('efficient', 'Qoder Efficient', 180_000, true),
  fallbackModel('lite', 'Qoder Lite', 180_000, false),
]

/** Replace one row's served window and remember what it was before. */
function withServedWindow(entry: QoderModelInfo, contextWindow: number): QoderModelInfo {
  return {
    ...entry,
    defaultContextWindow: entry.defaultContextWindow ?? entry.contextWindow,
    contextWindow,
  }
}

/** The largest of a row's declared windows, or undefined when it declares none. */
function largestDeclared(entry: QoderModelInfo): number | undefined {
  const declared = entry.supportedContextWindows
  if (declared === undefined || declared.length === 0) return undefined
  return Math.max(...declared)
}

/**
 * Mutable catalog shared by the loopback model list and the pi-ai adapter.
 *
 * Visibility is tracked separately from content: a provider without a usable
 * credential exposes no rows at all, which is how the picker hides the group.
 * Showing the fallback roster in that state would only offer models that are
 * guaranteed to fail.
 */
export class QoderCatalog {
  private entries: readonly QoderModelInfo[]
  private visible = true
  private useLargestWindow = false
  private readonly disabled = new Set<string>()

  constructor(initial: readonly QoderModelInfo[] = FALLBACK_QODER_MODELS) {
    this.entries = initial
  }

  /** The served rows: hidden while signed out, with disabled models removed. */
  current(): readonly QoderModelInfo[] {
    if (!this.visible) return []
    return this.all().filter(entry => !this.disabled.has(entry.id))
  }

  /** Every configured row, disabled ones included, with the current window applied. */
  all(): readonly QoderModelInfo[] {
    if (!this.visible) return []
    return this.entries.map(entry => this.servedEntry(entry))
  }

  /** Replace the model list wholesale. */
  set(models: readonly QoderModelInfo[]): void {
    this.entries = [...models]
  }

  /** Whether the catalog is exposed at all. */
  isVisible(): boolean {
    return this.visible
  }

  /** Show or hide the catalog; returns whether the value changed. */
  setVisible(visible: boolean): boolean {
    if (this.visible === visible) return false
    this.visible = visible
    return true
  }

  /** Prefer each model's largest declared window; returns whether the value changed. */
  setUseMaximumContextWindow(useMaximum: boolean): boolean {
    if (this.useLargestWindow === useMaximum) return false
    this.useLargestWindow = useMaximum
    return true
  }

  /** Replace the disabled model ids; returns whether the membership changed. */
  setDisabledModels(disabledModels: readonly string[]): boolean {
    const next = new Set(disabledModels)
    const unchanged = next.size === this.disabled.size && [...next].every(id => this.disabled.has(id))
    if (unchanged) return false
    this.disabled.clear()
    for (const id of next) this.disabled.add(id)
    return true
  }

  /** The ids currently disabled. */
  getDisabledModels(): readonly string[] {
    return [...this.disabled]
  }

  /** The configured rows regardless of visibility; for callers that know the credential state. */
  fallback(): readonly QoderModelInfo[] {
    return this.entries
  }

  /** One row with the effective context window applied. */
  private servedEntry(entry: QoderModelInfo): QoderModelInfo {
    if (!this.useLargestWindow) return entry
    const largest = largestDeclared(entry)
    return largest !== undefined && largest > entry.contextWindow
      ? withServedWindow(entry, largest)
      : entry
  }
}
