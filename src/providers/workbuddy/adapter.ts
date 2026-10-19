/**
 * The WorkBuddy pi-ai provider: one loopback-backed adapter registered into the
 * harness LLM seam, assembled from the public `dsh-llm-pi-ai` extension points.
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyProbeRecord } from './probe-store.ts'
import type { WorkBuddyShim } from './shim.ts'
import { normalizeCredits, type WorkBuddyRegion } from './upstream.ts'

/** Provider idle ceiling while one stream read is outstanding. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. The workbuddy route authenticates only through the
 * shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
 * credential lifecycle and ambient discovery must never manufacture a
 * credential for it.
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-connect-hub: the workbuddy route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Separator between a model name and its billing suffix. */
const RATE_SEPARATOR = ' · '

/**
 * The catalog display suffix: the billing rate followed by the declared promo
 * badges, or undefined when the row carries neither. The host seam has no locale
 * service, so these labels are shown verbatim in every UI language.
 */
function displaySuffix(info: WorkBuddyModelInfo): string | undefined {
  const parts = [normalizeCredits(info.billing?.credits), ...(info.billing?.badges ?? [])].filter(
    (part): part is string => part !== undefined && part !== '',
  )
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name: string, info: WorkBuddyModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`
}

/** Constructor dependencies. */
export interface WorkBuddyAdapterOptions {
  providerId: string
  displayName: string
  /** Which endpoint this adapter serves; decides only the CN `onlyReasoning` veto. */
  region: WorkBuddyRegion
  shim: Pick<WorkBuddyShim, 'baseUrl' | 'token'>
  catalog: WorkBuddyCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Resolve one image's path in the current model-tool execution world. */
  resolveImageAccess?: NonNullable<PiAiAdapterOptions['resolveImageAccess']>
  /**
   * Look up a local probe observation for a model. Consulted only for rows the
   * upstream left undeclared; absent means declared-set-only behavior.
   */
  observe?: (modelId: string) => WorkBuddyProbeRecord | undefined
  /**
   * Model ids the current account has hidden from the picker, resolved per read
   * so an account switch is honored without rebuilding the adapter.
   *
   * Hiding is a listing concern only: `buildModels()` keeps serving the full
   * catalog because pi-ai's `resolveModel`/`prepareCall` resolve from the same
   * snapshot `listModels` reads — filtering the descriptors there would make a
   * hidden model unresolvable and break sessions already using it.
   */
  hidden?: () => readonly string[]
}

/** What {@link createWorkBuddyAdapter} hands back. */
export interface WorkBuddyAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/**
 * Resolve a WorkBuddy model's reasoning capability into pi-ai's
 * `thinkingLevelMap` (every level pinned to its wire spelling or `null`).
 *
 * Two sources, strictly ordered: the declared set always wins; a local
 * observation may supply a set only for rows the upstream left undeclared, and
 * only when that observation established the upstream validates the parameter.
 * A `non-validating` observation deliberately yields no control.
 *
 * `off` is offered only when the upstream declares `canDisableThinking: true`,
 * and is never probed. The CN endpoint vetoes it further on models declaring
 * `onlyReasoning`: that catalog ships both flags true, and the endpoint answers
 * HTTP 400 for every `off` request, so the contradiction is resolved toward the
 * flag the wire agrees with.
 */
export function reasoningFields(
  info: WorkBuddyModelInfo,
  observed?: WorkBuddyProbeRecord,
  region: WorkBuddyRegion = 'cn',
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) return { reasoning: false }
  const declared = reasoning.supportedEfforts
  const efforts =
    declared !== undefined && declared.length > 0
      ? declared
      : observed?.validation === 'validating' && observed.efforts.length > 0
        ? observed.efforts
        : undefined
  if (efforts === undefined) return { reasoning: false }
  const map: Record<ModelThinkingLevel, string | null> = {
    off:
      reasoning.canDisableThinking === true
      && (region !== 'cn' || reasoning.onlyReasoning !== true)
      && declared !== undefined
      && declared.length > 0
        ? 'off'
        : null,
    // `minimal` is absent from the upstream effort vocabulary.
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
function toPiModel(
  info: WorkBuddyModelInfo,
  baseUrl: string,
  observed: WorkBuddyProbeRecord | undefined,
  providerId: string,
  region: WorkBuddyRegion,
): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info, observed, region),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    // pi-ai cannot infer WorkBuddy's field spelling from the shim's random
    // loopback URL, so name the upstream-required field explicitly.
    compat: { maxTokensField: 'max_tokens' },
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog, and
 * every model's `baseUrl` is re-resolved per read so the shim's ephemeral port
 * applies from the first snapshot after startup.
 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter {
  const { shim, catalog, resolveAttachments, resolveImageAccess, observe, hidden } = options
  const providerId = options.providerId
  const displayName = options.displayName
  const region = options.region

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL, so the
    // shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map((info) => toPiModel(info, baseUrl, observe?.(info.id), providerId, region))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'WorkBuddy OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'WorkBuddy' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-hub workbuddy retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new WorkBuddyPiAiAdapter(catalog, hidden ?? (() => []), {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so pi-ai
    // sends it as `Authorization: Bearer <shared-secret>`. The shim validates it
    // before forwarding and resolves the real WorkBuddy token itself, so the
    // secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    ...(resolveAttachments === undefined ? {} : { resolveAttachments }),
    ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}

/**
 * The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded into
 * the catalog answers it returns to the harness model pickers.
 *
 * Both overrides delegate to `super` and then rewrite only the display fields,
 * so streaming, capability resolution, and effort mapping stay exactly as
 * `dsh-llm-pi-ai` implements them. A model missing from the catalog falls
 * through with its name untouched rather than being dropped.
 */
class WorkBuddyPiAiAdapter extends PiAiAdapter {
  constructor(
    private readonly catalog: WorkBuddyCatalog,
    private readonly hidden: () => readonly string[],
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  private infoFor(model: string): WorkBuddyModelInfo | undefined {
    return this.catalog.current().find((entry) => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    // Resolved fresh per call: the picker reads this after every
    // `llm/adapters-updated`, so an account switch or a toggle takes effect on
    // the next read without rebuilding anything.
    const hidden = new Set(this.hidden())
    return models.flatMap((model) => {
      // Selectability only — `resolveModel` deliberately does not apply this
      // filter, so a session already using a hidden model keeps working.
      if (hidden.has(model.id)) return []
      const info = this.infoFor(model.id)
      if (info === undefined) return [model]
      return [{ ...model, name: withCatalogDisplay(model.name, info) }]
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: withCatalogDisplay(resolved.name, info) }
  }
}
