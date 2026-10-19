/** Read the signed-in Qoder user behind any accepted access token. */

import { QoderLlmError } from '../errors.ts'
import { getQoderUserInfoUrl } from './endpoints.ts'
import type { QoderRegion } from '../region.ts'
import { openApiJsonRequest } from './request.ts'
import type { QoderLogger } from './logging.ts'

/** The identity fields every Qoder consumer needs. */
export interface QoderUserIdentity {
  userID: string
  name: string
  email: string
}

export interface QoderUserInfoOptions {
  region: QoderRegion
  token: string
  signal: AbortSignal
  timeoutMs?: number
  fetch?: typeof fetch
  logger?: QoderLogger
}

/**
 * Fetch the profile with a bearer token. Used both after a PAT exchange and
 * for a desktop-imported device token, which never needs an exchange at all.
 */
export async function fetchQoderUserInfo(options: QoderUserInfoOptions): Promise<QoderUserIdentity> {
  const info = await openApiJsonRequest<{
    id?: string
    email?: string
    name?: string
    username?: string
  }>(options.fetch ?? globalThis.fetch, {
    url: getQoderUserInfoUrl(options.region),
    token: options.token,
    signal: options.signal,
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ...options.logger === undefined ? {} : { logger: options.logger },
    operation: 'UserInfo',
    logCategory: 'auth.user-info',
  })
  if (!info.id) {
    throw new QoderLlmError('Qoder identity lookup returned no user id.', 'AUTH')
  }
  return {
    userID: info.id,
    name: info.name ?? info.username ?? '',
    email: info.email ?? '',
  }
}
