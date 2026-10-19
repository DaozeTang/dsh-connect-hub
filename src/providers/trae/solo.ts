import { responseHeaderTimeout } from '../../core/abort.ts'
import type { TraeCredential } from './auth.ts'
import type { TraeIdentity } from './identity.ts'
import { buildTraeHeaders, traeEndpoint } from './protocol.ts'
import { REGION_GATEWAYS, regionOfCredential, type TraeRegion } from './region.ts'
import { parseReasoningCapability, type TraeReasoningCapability } from './reasoning.ts'
import type { TraeChatResult, TraeUpstreamErrorKind } from './upstream.ts'

export const TRAE_SOLO_FUNCTION = 'solo_work_lite'

/**
 * `llm_utils_chat` functions to union per region, in priority order.
 *
 * Trae spreads its callable roster across several SOLO-mode functions, and a
 * model is only usable through the one that lists it. The directory unions all
 * of them, and the first function to provide a config owns that config — so
 * this order decides both the wire name and the function a chat call replays.
 *
 * `solo_agent` is deliberately absent: it is a Remote-agent roster function,
 * not a chat function (chat calls through it answer Trae's 4011 rate-limit
 * error). `solo_agent_remote` is the chat-callable half of that roster and is
 * asked late so the IDE functions keep precedence. A model no chat function
 * lists still ships through the merge; its call fails with a readable upstream
 * message instead of being silently hidden.
 */
export const TRAE_DIRECTORY_FUNCTIONS: Readonly<Record<TraeRegion, readonly string[]>> = {
  cn: ['solo_work_remote', TRAE_SOLO_FUNCTION, 'solo_agent_remote', 'chat_v3', 'solo_coder'],
  ai: ['solo_work_remote', TRAE_SOLO_FUNCTION, 'solo_agent_remote', 'chat_v3'],
}
export const TRAE_SOLO_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
export const TRAE_SOLO_MODELS_PATH = '/api/ide/v1/get_detail_param'
/** Deadline for chat response headers; an accepted stream may run much longer. */
const CHAT_HEADER_TIMEOUT_MS = 60_000

function classify(status: number): TraeUpstreamErrorKind {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function prepareSoloBody(source: string, defaultModel = 'glm-5.2', functionName?: string): string {
  const input = JSON.parse(source) as Record<string, unknown>
  const requestedModel = typeof input['model'] === 'string' && input['model'].trim() !== '' ? input['model'].trim() : defaultModel
  const model = requestedModel
  // llm_utils_chat is not an OpenAI-compatible endpoint. Build its evidenced
  // envelope explicitly so optional Pi/OpenAI fields (temperature, max_tokens,
  // tool_choice, response_format, etc.) cannot make every model fail validation.
  const body: Record<string, unknown> = {
    ...Array.isArray(input['messages']) ? { messages: input['messages'] } : {},
    model,
    config_name: model,
    // The directory function that actually lists this model (see
    // TRAE_DIRECTORY_FUNCTIONS). The bridge may have already stamped the exact
    // function it learned from the directory, which wins over the default.
    function: typeof input['function'] === 'string' && input['function'] !== ''
      ? input['function']
      : (functionName ?? TRAE_SOLO_FUNCTION),
    stream: true,
    ...Array.isArray(input['tools']) ? { tools: input['tools'] } : {},
    ...typeof input['reasoning_effort'] === 'string' ? { reasoning_effort: input['reasoning_effort'] } : {},
  }
  if (Array.isArray(body['messages'])) {
    for (const raw of body['messages']) {
      if (typeof raw !== 'object' || raw === null) continue
      const message = raw as Record<string, unknown>
      // DSH sends the system prompt as the OpenAI `developer` role, which the
      // Trae `llm_utils_chat` upstream rejects with a 400 (it accepts only
      // system / assistant / user / tool / function). Normalise it.
      if (message['role'] === 'developer') message['role'] = 'system'
      if (typeof message['content'] === 'string') message['content'] = [{ type: 'text', text: message['content'] }]
      if (message['role'] === 'assistant' && Array.isArray(message['tool_calls'])) {
        for (const rawCall of message['tool_calls']) {
          if (typeof rawCall !== 'object' || rawCall === null) continue
          const call = rawCall as Record<string, unknown>
          if (typeof call['function'] === 'object' && call['function'] !== null) {
            call['function_call'] = call['function']
            delete call['function']
          }
        }
      }
      if (message['role'] === 'tool') {
        message['role'] = 'tool'
        if (typeof message['tool_call_id'] !== 'string' || message['tool_call_id'] === '') {
          throw new Error('Trae SOLO tool message requires tool_call_id')
        }
      }
    }
  }
  if (Array.isArray(body['tools'])) {
    for (const raw of body['tools']) {
      if (typeof raw !== 'object' || raw === null) continue
      const fn = (raw as Record<string, unknown>)['function']
      if (typeof fn !== 'object' || fn === null) continue
      const record = fn as Record<string, unknown>
      if (typeof record['parameters'] === 'object' && record['parameters'] !== null) record['parameters'] = JSON.stringify(record['parameters'])
    }
  }
  return JSON.stringify(body)
}

export interface TraeSoloModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: TraeReasoningCapability
  /** Effective (post-discount) credit multiplier, as the Trae IDE shows it. */
  creditMultiplier?: number
  /** The directory function that listed this config (replayed when calling it). */
  function?: string
}

/**
 * Read the effective credit multiplier from a `get_detail_param` row.
 *
 * The rate the Trae IDE renders lives in `display_contact_config` — a *string*
 * holding a second JSON document — and its `consumption_rate.data.rate` is
 * already the post-discount value (the
 * Remote directory reports the undiscounted figure, e.g. `0.8`, while the IDE
 * and this field both say `0.08` under a 限时 1 折 promotion — up to a 10x
 * difference). The wire figure therefore wins over the Remote one during the
 * merge; this parser is what feeds it.
 *
 * The international (ai) gateway serves no `consumption_rate` anywhere (its
 * subscription models carry only `features.cost` tags), so rows without the
 * field keep their bare name — parsed-but-absent, never fabricated.
 */
function wireCreditMultiplier(config: Record<string, unknown>): number | undefined {
  const raw = config['display_contact_config']
  if (typeof raw !== 'string' || raw === '') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const consumption = (parsed as Record<string, unknown>)['consumption_rate']
  if (typeof consumption !== 'object' || consumption === null) return undefined
  const entry = consumption as Record<string, unknown>
  if (entry['enable'] !== true) return undefined
  const data = entry['data']
  if (typeof data !== 'object' || data === null) return undefined
  return finitePositive((data as Record<string, unknown>)['rate'])
}

export interface TraeSoloClientOptions {
  credential(): Promise<TraeCredential>
  identity(): Promise<TraeIdentity>
  baseUrl?: string
  fetchImpl?: typeof fetch
  log?: (message: string, detail?: unknown) => void
}

/**
 * Thrown by {@link TraeSoloUpstreamClient.fetchModels} when every requested
 * directory function answered HTTP 200 with an EMPTY `config_info_list`, so the
 * aggregate roster is empty. This is an upstream-side, usually transient gap
 * (the published function config temporarily missing) — not a local
 * credential, provider or account fault, and not something to re-login for. The
 * caller can catch this type to tell "the upstream published no config" apart
 * from "all directory functions errored" (which surfaces as a generic failure).
 */
export class TraeEmptySoloDirectory extends Error {
  override name = 'TraeEmptySoloDirectory'
  constructor() {
    super('Trae\u2019s server returned NO SOLO function config (an empty directory for every requested function) \u2014 an upstream-side gap that usually clears on its own; retry later instead of re-checking credentials or the provider')
  }
}

export class TraeSoloUpstreamClient {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: TraeSoloClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch }

  /**
   * Read the callable roster for this credential's region.
   *
   * Every function in {@link TRAE_DIRECTORY_FUNCTIONS} is asked, in order, and
   * their answers are unioned: the first function to list a `config_name` owns
   * it. Trae splits its roster across SOLO modes, and a model is only callable
   * through the function that lists it (glm-5.3 exists solely under
   * `solo_work_remote` on the CN gateway). Asking one function therefore
   * silently hides models that the other one serves. The remote directory
   * remains the merge skeleton, so agent-internal entries (search_agent_*,
   * paygo variants) never surface even though they appear here.
   */
  async fetchModels(signal?: AbortSignal): Promise<TraeSoloModel[]> {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()])
    const region = regionOfCredential(credential)
    const base = this.options.baseUrl ?? REGION_GATEWAYS[region].chat
    const headers = { ...buildTraeHeaders(credential, identity), Accept: 'application/json' }
    const byId = new Map<string, TraeSoloModel>()
    const failures: string[] = []
    for (const directoryFunction of TRAE_DIRECTORY_FUNCTIONS[region]) {
      let list: unknown[]
      try {
        const response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            function: directoryFunction,
            config_names: null,
            need_prompt: false,
            current_config_info: null,
            poly_prompt: true,
            mode_type: null,
            agent_type: null,
          }),
          signal: signal ?? AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const document = await response.json() as Record<string, unknown>
        list = Array.isArray(document['config_info_list']) ? document['config_info_list'] : []
      } catch (error: unknown) {
        // One function failing must not hide the others' rosters.
        failures.push(`${directoryFunction}: ${String(error).slice(0, 80)}`)
        continue
      }
      this.collectModels(list, directoryFunction, byId)
    }
    const models = [...byId.values()]
    if (models.length === 0) {
      // No failures AND no rows: every requested function answered HTTP 200 with
      // an empty config_info_list — the upstream published NO function config
      //, which is distinct from a transport failure.
      // Surface it with the honest dedicated error so the caller can tell the
      // two situations apart; otherwise keep the generic per-function message.
      if (failures.length === 0) throw new TraeEmptySoloDirectory()
      throw new Error(`Trae SOLO models response contained no models (${failures.join('; ')})`)
    }
    return models
  }

  /** Merge one function's config list into the shared catalogue (first wins). */
  private collectModels(list: readonly unknown[], directoryFunction: string, byId: Map<string, TraeSoloModel>): void {
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue
      const config = raw as Record<string, unknown>
      const id = typeof config['config_name'] === 'string' ? config['config_name'] : ''
      if (id === '') continue
      const display = typeof config['display_config'] === 'object' && config['display_config'] !== null ? config['display_config'] as Record<string, unknown> : {}
      const details = Array.isArray(config['model_detail_list']) ? config['model_detail_list'] : []
      const detail = typeof details[0] === 'object' && details[0] !== null ? details[0] as Record<string, unknown> : {}
      // get_detail_param's real field names: the context
      // window is `model_detail_list[].prompt_max_tokens` (or the top-level
      // `context_window_tokens.dev`), and max output is `model_detail_list[].max_tokens`.
      // There are no `max_input_tokens` / `max_output_tokens` fields; reading them
      // made every row's windows nil. The wire `config_name` (what `llm_utils_chat`
      // accepts) is `config_name` itself — NOT `model_name` (a `__dev`/`__max`
      // variant that only names the underlying checkpoint).
      const contextTokens = typeof config['context_window_tokens'] === 'object' && config['context_window_tokens'] !== null ? config['context_window_tokens'] as Record<string, unknown> : {}
      const promptMaxTokens = finitePositive(detail['prompt_max_tokens'])
      const devTokens = finitePositive(contextTokens['dev'])
      const contextWindow = promptMaxTokens ?? devTokens
      const maxTokens = finitePositive(detail['max_tokens'])
      const reasoning = parseReasoningCapability({ ...config, ...detail })
      const creditMultiplier = wireCreditMultiplier(config)
      // First function to list a config_name owns it: TRAE_DIRECTORY_FUNCTIONS
      // is ordered by precedence, and this is what makes a model callable (the
      // chat call replays this exact function).
      if (byId.has(id)) continue
      byId.set(id, {
        id,
        name: typeof display['display_name'] === 'string' && display['display_name'] !== '' ? display['display_name'] : id,
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxTokens === undefined ? {} : { maxTokens },
        ...reasoning === undefined ? {} : { reasoning },
        ...creditMultiplier === undefined ? {} : { creditMultiplier },
        function: directoryFunction,
      })
    }
  }

  async chatStream(bodyJson: string, signal?: AbortSignal, functionName?: string): Promise<TraeChatResult> {
    let prepared: string
    try { prepared = prepareSoloBody(bodyJson, undefined, functionName) }
    catch { return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' } }
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()])
    const headers = buildTraeHeaders(credential, identity)
    const base = this.options.baseUrl ?? REGION_GATEWAYS[regionOfCredential(credential)].chat
    let response: Response
    // The shim always passes its request signal; compose a cancellable header
    // timeout so a silent upstream cannot hold the request open, while a
    // healthy long stream is not cut off by a body-wide deadline.
    const header = responseHeaderTimeout(signal, CHAT_HEADER_TIMEOUT_MS)
    try {
      response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_CHAT_PATH), {
        method: 'POST', headers, body: prepared, signal: header.signal,
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    } finally {
      header.settle()
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, 1024)
    const logged = JSON.parse(prepared) as Record<string, unknown>
    this.options.log?.('dsh-connect-hub: llm_utils_chat rejected', {
      status: response.status,
      model: logged['model'],
      configName: logged['config_name'],
      reasoningEffort: logged['reasoning_effort'],
      body: text,
    })
    return { ok: false, status: response.status, kind: classify(response.status), message: text || `Trae SOLO returned HTTP ${response.status}` }
  }
}
