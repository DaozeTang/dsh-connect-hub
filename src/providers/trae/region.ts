/**
 * Which Trae service region a credential belongs to, and the verified gateway
 * bases for each. Two buckets exist: the domestic (`cn`) service and the
 * international (`ai`) service.
 *
 * A credential carries its region at up to three levels, tried in order: the
 * `userRegion` claim in the storage document, the host suffix, then the edition
 * label. Nothing here reads user configuration.
 */
import type { TraeEdition } from './paths.ts'

/** Storage/routing bucket: the domestic service or the international one. */
export type TraeRegion = 'cn' | 'ai'

/** One region's verified endpoint bases. */
export interface TraeRegionGateways {
  /** Chat + agent API base. */
  readonly chat: string
  /** SOLO remote model directory base. */
  readonly remote: string
  /** Pay/status API base. */
  readonly pay: string
}

export const REGION_GATEWAYS: Readonly<Record<TraeRegion, TraeRegionGateways>> = {
  cn: {
    chat: 'https://trae-api-cn.mchost.guru',
    remote: 'https://solo.trae.cn/api/remote/v1',
    pay: 'https://api.trae.cn',
  },
  ai: {
    chat: 'https://coresg-normal.trae.ai',
    remote: 'https://coresg-normal.trae.ai/api/remote/v1',
    pay: 'https://growsg-normal.trae.ai',
  },
}

/** International install labels map to the international bucket. */
export function regionOfEdition(edition: TraeEdition): TraeRegion {
  return edition === 'sg' || edition === 'solo-sg' ? 'ai' : 'cn'
}

/** Unwrap the two on-disk spellings of the `userRegion` claim into its string. */
function claimText(value: unknown): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

/**
 * Region of the credential's own `userRegion` claim.
 *
 * The desktop storage spells it as an object (`{"region":"CN",…}`) and app logs
 * spell a bare value; both are accepted, case-blind, with `sg` and `ai` both
 * meaning the international bucket.
 */
export function regionOfUserRegion(value: unknown): TraeRegion | undefined {
  const text = claimText(value)
  if (text === undefined) return undefined
  const lowered = text.toLowerCase()
  if (lowered === 'cn') return 'cn'
  if (lowered === 'sg' || lowered === 'ai') return 'ai'
  return undefined
}

/** Extract a hostname from a full URL or a bare host string. */
function hostnameOf(value: string): string {
  const candidate = value.startsWith('http') ? value : `https://${value}`
  return new URL(candidate).hostname
}

function isAiHostname(hostname: string): boolean {
  return hostname === 'trae.ai' || hostname.endsWith('.trae.ai')
}

function isCnHostname(hostname: string): boolean {
  return hostname === 'trae.cn' || hostname.endsWith('.trae.cn') || hostname.endsWith('.trae.com.cn')
}

/** Region of a credential host suffix (`.trae.ai` → ai, `.trae.cn` → cn). */
export function regionOfHost(host: string | undefined): TraeRegion | undefined {
  const value = host?.trim() ?? ''
  if (value === '') return undefined
  let hostname: string
  try {
    hostname = hostnameOf(value)
  } catch {
    return undefined
  }
  if (isAiHostname(hostname)) return 'ai'
  if (isCnHostname(hostname)) return 'cn'
  return undefined
}

/**
 * Region of a stored credential: the claim wins, then the host, then the
 * edition label. Every level comes from data the credential itself carries, so
 * a region is always derivable without asking the user.
 */
export function regionOfCredential(credential: {
  edition: TraeEdition
  host?: string
  userRegion?: string
}): TraeRegion {
  const candidates: (TraeRegion | undefined)[] = [
    regionOfUserRegion(credential.userRegion),
    regionOfHost(credential.host),
    regionOfEdition(credential.edition),
  ]
  return candidates.find((region): region is TraeRegion => region !== undefined) ?? regionOfEdition(credential.edition)
}
