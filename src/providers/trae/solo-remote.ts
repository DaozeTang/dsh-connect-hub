import type { TraeCredential } from './auth.ts'
import { parseTraeRemoteModel, type TraeDiscoveredModel } from './model-metadata.ts'
import { REGION_GATEWAYS, regionOfCredential, type TraeRegion } from './region.ts'

/**
 * Remote-directory functions to ask for, per region.
 *
 * The remote `/models` answer is grouped by function, and the groups are not
 * interchangeable: `solo_agent` is a superset of `solo_agent_remote`, and the
 * narrower group alone hides models the Trae IDE shows. Every group is
 * therefore requested and every returned group is unioned; asking for a
 * function the gateway does not serve is harmless (unknown names are ignored,
 * and a region that does not serve a group simply returns none for it).
 *
 * `chat_v3` carries ai-region models that appear in no other group (and is a
 * callable chat function, see `TRAE_DIRECTORY_FUNCTIONS`). `builder_v3` is
 * included because its rows are real directory entries; whether a given
 * account can call one is not something this client can determine.
 *
 * An unread group would be a model silently missing from the user's list, which
 * is the failure this list exists to prevent.
 */
export const TRAE_REMOTE_DIRECTORY_FUNCTIONS: Readonly<Record<TraeRegion, readonly string[]>> = {
  cn: ['solo_agent', 'solo_agent_remote', 'solo_work_remote', 'solo_work_lite', 'chat_v3', 'solo_coder', 'builder_v3'],
  ai: ['solo_agent', 'solo_agent_remote', 'solo_work_remote', 'solo_work_lite', 'chat_v3', 'solo_coder', 'builder_v3'],
}

export interface TraeSoloRemoteCatalogOptions {
  credential(): Promise<TraeCredential>
  fetchImpl?: typeof fetch
  baseUrl?: string
}

/**
 * Of two rows for the SAME model id, the one that advertises the stronger
 * capacity.
 *
 * The gateway groups its directory by function and reports a model's capacity
 * per group, with the group order varying between calls. Keeping the strongest
 * row makes the published window deterministic. The comparison is
 * LEXICOGRAPHIC and must be applied all the way down, or ordering leaks back in
 * at the next field:
 *
 * 1. a row with a Max tier beats one without (`maxContextWindow` is only set
 * when the group reported `max_mode: true` with a positive max);
 * 2. two Max rows: the larger max wins;
 * 3. max equal (or absent on both): the WIDER dev window wins;
 * 4. both equal: keep the incumbent, so the model order stays the gateway's.
 *
 * Step 3 matters: with equal `max`, keeping the incumbent leaves the dev window
 * decided by arrival order (for example `glm-5.2` reporting `dev=116000` from
 * one group and `dev=200000` from another, both with `max=1000000`). A budgeted
 * model still resolves to its Max either way, but the DEFAULT window of an
 * unbudgeted model — what DSH shows and compresses against — must not be a coin
 * flip.
 */
export function preferStrongerRow(
  candidate: TraeDiscoveredModel,
  incumbent: TraeDiscoveredModel | undefined,
): TraeDiscoveredModel {
  if (incumbent === undefined) return candidate
  const candidateMax = candidate.maxContextWindow
  const incumbentMax = incumbent.maxContextWindow
  if (candidateMax !== undefined && incumbentMax === undefined) return candidate
  if (candidateMax === undefined && incumbentMax !== undefined) return incumbent
  if (candidateMax !== undefined && incumbentMax !== undefined && candidateMax !== incumbentMax) {
    return candidateMax > incumbentMax ? candidate : incumbent
  }
  // Equal Max (or neither advertises one): the wider dev window wins.
  return (candidate.contextWindow ?? 0) > (incumbent.contextWindow ?? 0) ? candidate : incumbent
}

/**
 * Region-scoped request dressing. The CN portal is `solo.trae.cn` with the
 * CN locale headers; the international directory lives on the shared
 * `coresg-normal.trae.ai` gateway and was verified with the
 * English/Singapore headers — both forms are accepted, each region keeps the
 * shape its own portal sends.
 */
function remoteDressing(region: TraeRegion): { referer: string; timezone: string; language: string } {
  return region === 'ai'
    ? { referer: 'https://coresg-normal.trae.ai/', timezone: 'Asia/Singapore', language: 'en' }
    : { referer: 'https://solo.trae.cn/', timezone: 'Asia/Shanghai', language: 'zh-cn' }
}

/**
 * Read-only model catalog client for the SOLO Web API.
 *
 * This deliberately has no chat/session method: the Remote session protocol
 * only exposes a final answer and cannot preserve DSH's structured tool loop.
 */
export class TraeSoloRemoteCatalogClient {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string | undefined

  constructor(private readonly options: TraeSoloRemoteCatalogOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl
  }

  private async headers(region: TraeRegion): Promise<Record<string, string>> {
    const credential = await this.options.credential()
    const dressing = remoteDressing(region)
    return {
      'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
      'Content-Type': 'application/json',
      'x-trae-client-type': 'web',
      'x-trae-user-timezone': dressing.timezone,
      'x-preferenced-language': dressing.language,
      'Referer': dressing.referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  }

  async fetchModels(signal?: AbortSignal): Promise<TraeDiscoveredModel[]> {
    // The directory gateway follows the credential's own region; an explicit
    // baseUrl (tests, diagnostics) still pins the endpoint.
    const credential = await this.options.credential()
    const region = regionOfCredential(credential)
    const base = this.baseUrl ?? REGION_GATEWAYS[region].remote
    const headers = await this.headers(region)
    const functions = TRAE_REMOTE_DIRECTORY_FUNCTIONS[region].join(',')
    const response = await this.fetchImpl(`${base}/models?functions=${functions}`, { headers, signal: signal ?? AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`SOLO remote models returned HTTP ${response.status}`)
    const json = await response.json() as { code?: number; data?: { list?: { function?: string; models?: unknown[] }[] } }
    const groups = json.data?.list ?? []
    // Union EVERY group, not just the preferred one: each group is a roster the
    // gateway is willing to serve, and the wire join downstream (see
    // mergeTraeModelSources) decides whether a row is actually callable.
    //
    // A model appears in several groups and the groups disagree about its
    // capacity, and the group order is not stable between calls. Dedupe
    // therefore keeps the MOST CAPABLE row rather than the first one, so the
    // published window does not depend on arrival order: a row advertising a
    // Max tier beats one that does not, a larger Max wins over a smaller one,
    // and with no Max on either side the wider dev window wins (see
    // `preferStrongerRow`). Every row for one id carries the same
    // multimodal / reasoning / credit facts, so choosing on capacity loses no
    // capability.
    const byId = new Map<string, TraeDiscoveredModel>()
    for (const group of groups) {
      for (const raw of group.models ?? []) {
        const model = parseTraeRemoteModel(raw)
        if (model === undefined) continue
        byId.set(model.id, preferStrongerRow(model, byId.get(model.id)))
      }
    }
    const models = [...byId.values()]
    if (models.length === 0) throw new Error('SOLO remote models response contained no models')
    return models
  }
}
