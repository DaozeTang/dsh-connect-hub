/**
 * The Qoder pi-ai provider: one loopback-backed adapter per variant route,
 * registered into the Harness LLM seam through the public `dsh-llm-pi-ai`
 * extension points.
 *
 * @module dsh-connect-hub/providers/qoder/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderCatalog, QoderModelInfo } from './catalog.ts'
import type { QoderShim } from './shim.ts'
import { normalizeCredits } from './upstream.ts'

/** Default provider route owned by this bundle (the China variant). */
const QODER_PROVIDER = 'qoder'

/** Provider idle ceiling while one stream read is outstanding. */
const QODER_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults. They bound requests to
 * models whose catalog entry declares `supportsImages`; text-only models never
 * receive images.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. Qoder routes authenticate only through the shim's
 * per-request shared secret, so pi-ai's own credential lifecycle and ambient
 * discovery must never manufacture one. Every question here answers "nothing
 * stored, nothing set".
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('qoder: routes have no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * The suffix appended to a model's display name so its billing rate is visible
 * wherever the name is shown.
 *
 * The separator is a middle dot rather than a hyphen or colon: model names
 * commonly contain hyphens, so a hyphen separator would be ambiguous about
 * where the name ends and the rate begins.
 */
const RATE_SEPARATOR = ' · '

/**
 * What the model seat shows in place of a rate the plugin cannot stand behind.
 *
 * The seat has no locale service (the adapter is a host seam), so this is a
 * literal; it matches the settings card's own wording for the same state.
 * Rendering it as WORDS rather than an empty slot: every other model in the
 * seat shows `· x0.3`, so a bare name where the rate should be reads as a
 * rendering bug. This plugin's fallback roster carries no rate at all, so the
 * case is not hypothetical.
 */
const RATE_UNAVAILABLE = '价格暂不可用'

/**
 * The catalog display suffix: the normalized billing rate, when the row has
 * one. It rides `model.name` because the host's pickers render only that field;
 * routing uses `model.id`, so this cannot affect which model is called.
 */
function displaySuffix(info: QoderModelInfo): string | undefined {
  if (info.billing?.rateUnknown === true) return RATE_UNAVAILABLE
  const rate = normalizeCredits(info.billing?.credits)
  return rate === undefined || rate === '' ? undefined : rate
}

/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name: string, info: QoderModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`
}

/** Constructor dependencies. */
export interface QoderAdapterOptions {
  providerId?: string
  displayName?: string
  shim: QoderShim
  catalog: QoderCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** What {@link createQoderAdapter} hands back. */
export interface QoderAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/**
 * Resolve a Qoder model's reasoning capability into pi-ai's
 * `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
 * unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
 *
 * Only the upstream's declared effort set grants a control. `off` is offered
 * solely when the row declares `canDisableThinking: true`; `minimal` is absent
 * from the upstream vocabulary and is never offered.
 */
export function reasoningFields(
  info: QoderModelInfo,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) {
    // Not a reasoning model: pi-ai reads a falsy `reasoning` as "off only".
    return { reasoning: false }
  }
  const declared = reasoning.supportedEfforts
  const efforts = declared !== undefined && declared.length > 0 ? declared : undefined
  if (efforts === undefined) {
    // Undeclared: no thinking control, and no `reasoning_effort` on the wire.
    return { reasoning: false }
  }
  const map: Record<ModelThinkingLevel, string | null> = {
    // Only an explicit declaration grants `off`.
    off: reasoning.canDisableThinking === true && declared !== undefined && declared.length > 0 ? 'off' : null,
    // `minimal` is not in the upstream effort vocabulary (EFFORT_VALUES).
    minimal: null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: QoderModelInfo, baseUrl: string, providerId = QODER_PROVIDER): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    // pi-ai cannot infer the shim's field spelling from a random loopback
    // URL, so name the upstream-required field explicitly.
    compat: { maxTokensField: 'max_tokens' },
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 *
 * The profile is constructed by hand rather than through dsh-llm-pi-ai's
 * internal `resolveProfiles()`: that helper is not part of the package's
 * public export surface, so hand-assembly is the supported path and every
 * profile field is adopted here explicitly.
 */
export function createQoderAdapter(options: QoderAdapterOptions): QoderAdapter {
  const { shim, catalog, resolveAttachments } = options
  const providerId = options.providerId ?? QODER_PROVIDER
  const displayName = options.displayName ?? 'Qoder'

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'Qoder shim shared secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: displayName }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, `dsh-connect-hub:${providerId} retryPolicy`),
    configuredMaxTokens: new Map(),
    // The live catalog only exposes serviceable models, so no per-model
    // failure needs reporting here.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new QoderPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real Qoder credential
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}

/**
 * The Qoder variant route's adapter: `PiAiAdapter` with the billing rate folded
 * into the catalog answers it returns to the DSH model pickers.
 *
 * `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
 * from the pi-ai descriptors, which carry no billing fact, so the rate is
 * layered on here by looking the model up in the live catalog. Both overrides
 * delegate to `super` and then rewrite only the display fields, so streaming,
 * capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
 * implements them.
 *
 * A model missing from the catalog (an id the shim would serve but the last
 * upstream refresh did not list) falls through with its name untouched rather
 * than being dropped: catalog membership is advisory, and the seam tolerates
 * serving an unlisted id.
 */
class QoderPiAiAdapter extends PiAiAdapter {
  constructor(
    private readonly catalog: QoderCatalog,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  private infoFor(model: string): QoderModelInfo | undefined {
    return this.catalog.current().find(entry => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      return { ...model, name: withCatalogDisplay(model.name, info) }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: withCatalogDisplay(resolved.name, info) }
  }

}
