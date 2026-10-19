import type { TraeCredential } from './auth.ts'
import { REGION_GATEWAYS, regionOfCredential, regionOfHost, regionOfUserRegion, type TraeRegion } from './region.ts'

/** A credential-supplied host, normalized to an HTTPS origin, with its region. */
export interface TraeGatewayHost {
  host: string
  region: TraeRegion
}

const ALLOWED_SCHEME = 'https:'
const STANDARD_PORTS: ReadonlySet<string> = new Set(['', '443'])

/** The verified gateway base a region's refresh uses when a credential has no host. */
export function canonicalRefreshHost(region: TraeRegion): string {
  return REGION_GATEWAYS[region].pay
}

function parseWebUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * Accept only a Trae-owned HTTPS origin.
 *
 * A refresh token is bearer material, so plaintext, embedded credentials and
 * non-standard ports are all refused; the hostname must belong to a known Trae
 * domain and the result is reduced to the origin (no path/query survives).
 */
export function normalizeTraeGatewayHost(value: string | undefined): TraeGatewayHost | undefined {
  const input = value?.trim() ?? ''
  if (input === '') return undefined
  const url = parseWebUrl(input)
  if (url === undefined || url.protocol !== ALLOWED_SCHEME) return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (!STANDARD_PORTS.has(url.port)) return undefined
  const region = regionOfHost(url.hostname)
  if (region === undefined) return undefined
  return { host: url.origin, region }
}

/** Region of one credential-supplied host when it is a known Trae gateway. */
export function regionOfRefreshHost(value: string | undefined): TraeRegion | undefined {
  return normalizeTraeGatewayHost(value)?.region
}

const INVALID_HOST_MESSAGE = 'Trae 登录主机不是已知的 HTTPS Trae 网关，已拒绝发送刷新令牌'
const REGION_MISMATCH_MESSAGE = 'Trae 登录主机与账号区域不一致，已拒绝发送刷新令牌'

/**
 * Resolve the base URL a stored credential's refresh request may go to.
 *
 * The destination is decided before any request is built: a host present on the
 * credential must be a known HTTPS Trae gateway agreeing with the credential's
 * region claim. A credential with no host at all uses its region's canonical
 * gateway. Anything else throws.
 */
export function refreshHostOf(credential: Pick<TraeCredential, 'host' | 'userRegion' | 'edition'>): string {
  const stored = credential.host.trim()
  if (stored === '') return canonicalRefreshHost(regionOfCredential(credential))
  const gateway = normalizeTraeGatewayHost(stored)
  if (gateway === undefined) throw new Error(INVALID_HOST_MESSAGE)
  const claim = regionOfUserRegion(credential.userRegion)
  if (claim !== undefined && claim !== gateway.region) throw new Error(REGION_MISMATCH_MESSAGE)
  return gateway.host
}
