import { randomUUID } from 'node:crypto'
import type { TraeCredential } from './auth.ts'
import type { TraeIdentity } from './identity.ts'
import { identityHeaders } from './identity.ts'

/**
 * Numeric version code sent when the persisted build version is not a plain
 * integer. Trae stores `iCubeLastVersion` as a dotted build string, while the
 * wire fields `x-app-version-code` / `x-ide-version-code` must bind as numbers;
 * a dotted value is rejected before the request reaches the model.
 *
 * Only the *format* of this field is normalized. Machine, device and app
 * version stay exactly as persisted — nothing here impersonates a device.
 */
export const TRAE_VERSION_CODE_FALLBACK = '20260716'

/** Keep a purely numeric build version; fall back when it cannot bind. */
export function normalizeTraeVersionCode(buildVersion: string | undefined): string {
  if (buildVersion === undefined || buildVersion.trim() === '') return TRAE_VERSION_CODE_FALLBACK
  const trimmed = buildVersion.trim()
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK
}

/**
 * Headers shared by every Trae edition: both gateways accept the same
 * `x-app-id`, identity headers and `Cloud-IDE-JWT` auth shape.
 */
export function buildTraeHeaders(
  credential: TraeCredential,
  identity: TraeIdentity,
): Record<string, string> {
  const requestId = randomUUID()
  const traceId = requestId.replaceAll('-', '').slice(0, 32)
  return {
    'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
    'X-Ide-Token': credential.accessToken,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${identity.appVersion ?? identity.buildVersion ?? 'unknown'}`,
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    ...identityHeaders(identity),
    // The upstream binds these as numbers; a dotted build string is rejected.
    'x-app-version-code': normalizeTraeVersionCode(identity.buildVersion),
    'x-ide-version-code': normalizeTraeVersionCode(identity.buildVersion),
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
    'X-Cloudide-Token': credential.accessToken,
    'x-uid': credential.userId,
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'Accept': 'text/event-stream',
  }
}

export function traeEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}
