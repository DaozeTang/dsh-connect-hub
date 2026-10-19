/**
 * Service endpoints for the two Qoder deployments.
 *
 * Every route is derived from one region description so a region can never mix
 * another deployment's hosts: the gateway serves chat and the model list, the
 * open-api host serves account and campaign reads, and the center host owns
 * published images and web search.
 */

import type { QoderRegion } from '../region.ts'

export type { QoderRegion } from '../region.ts'

export interface QoderRegionEndpoints {
  baseUrl: string
  openApiUrl: string
  /** Center service that owns durable image objects for multimodal input. */
  centerUrl: string
}

const SERVICE_ORIGINS: Record<QoderRegion, QoderRegionEndpoints> = {
  global: {
    baseUrl: 'https://api3.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
    centerUrl: 'https://center.qoder.sh',
  },
  china: {
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
    centerUrl: 'https://gateway.qoder.com.cn',
  },
}

/** Signed path of the center image upload route; it never carries an `/algo` prefix. */
export const qoderImageUploadPath = '/api/v2/image/upload'

/** The endpoint description for a region; unknown values fall back to global. */
export function resolveQoderEndpoints(region: QoderRegion = 'global'): QoderRegionEndpoints {
  return SERVICE_ORIGINS[region] ?? SERVICE_ORIGINS.global
}

/** A route on the region gateway; the gateway base deliberately keeps its trailing slash. */
function gatewayRoute(region: QoderRegion, route: string): string {
  return `${resolveQoderEndpoints(region).baseUrl}algo${route}`
}

/** A route on the region's open-api host. */
function openApiRoute(region: QoderRegion, route: string): string {
  return `${resolveQoderEndpoints(region).openApiUrl}${route}`
}

/** A signed route on the region's center host. */
function centerRoute(region: QoderRegion, route: string): string {
  const { centerUrl } = resolveQoderEndpoints(region)
  return `${centerUrl.replace(/\/+$/u, '')}/algo${route}`
}

const CHAT_ROUTE = '/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
const MODEL_LIST_ROUTE = '/api/v2/model/list?Encode=1'
const EXCHANGE_TOKEN_ROUTE = '/api/v1/jobToken/exchange'
const DEVICE_REFRESH_ROUTE = '/api/v1/deviceToken/refresh'
const USER_INFO_ROUTE = '/api/v1/userinfo'
const QUOTA_USAGE_ROUTE = '/api/v2/quota/usage'
const USER_PLAN_ROUTE = '/api/v2/user/plan'
const USER_STATUS_ROUTE = '/api/v3/user/status'
const CAMPAIGNS_ROUTE = '/sash/api/v1/me/campaigns'

/** Streaming chat-completion endpoint. */
export function getQoderChatUrl(region: QoderRegion = 'global'): string {
  return gatewayRoute(region, CHAT_ROUTE)
}

/** Model-discovery endpoint. */
export function getQoderModelListUrl(region: QoderRegion = 'global'): string {
  return gatewayRoute(region, MODEL_LIST_ROUTE)
}

/** Image-publication endpoint; the request id is forwarded when supplied. */
export function getQoderImageUploadUrl(region: QoderRegion = 'global', requestId?: string): string {
  const base = centerRoute(region, qoderImageUploadPath)
  return requestId === undefined ? base : `${base}?request_id=${encodeURIComponent(requestId)}`
}

/** Personal-token to job-token exchange endpoint. */
export function getQoderExchangeUrl(region: QoderRegion = 'global'): string {
  return openApiRoute(region, EXCHANGE_TOKEN_ROUTE)
}

/** Refresh a desktop sign-in's device token pair. */
export function getQoderDeviceRefreshUrl(region: QoderRegion = 'global'): string {
  return openApiRoute(region, DEVICE_REFRESH_ROUTE)
}

/** Subscriber profile endpoint. */
export function getQoderUserInfoUrl(region: QoderRegion = 'global'): string {
  return openApiRoute(region, USER_INFO_ROUTE)
}

/** Quota-usage endpoint. */
export function getQoderUsageUrl(region: QoderRegion = 'global'): string {
  return openApiRoute(region, QUOTA_USAGE_ROUTE)
}

/** Subscription-plan endpoint. */
export function getQoderUserPlanUrl(region: QoderRegion = 'global'): string {
  return openApiRoute(region, USER_PLAN_ROUTE)
}

/** Account-status endpoint. */
export function getQoderUserStatusUrl(region: QoderRegion = 'global'): string {
  return openApiRoute(region, USER_STATUS_ROUTE)
}

/** Campaign-inquiry endpoint. */
export function getQoderCampaignsUrl(region: QoderRegion = 'global'): string {
  return openApiRoute(region, CAMPAIGNS_ROUTE)
}

/** Campaign-claim endpoint. */
export function getQoderClaimCampaignUrl(region: QoderRegion = 'global', campaignId: string): string {
  return openApiRoute(region, `${CAMPAIGNS_ROUTE}/${encodeURIComponent(campaignId)}/claim`)
}
