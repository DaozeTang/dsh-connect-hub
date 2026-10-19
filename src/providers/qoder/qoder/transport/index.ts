/**
 * The public seam between the provider and the Qoder service.
 *
 * Everything that needs to talk to Qoder — discovery, account reads, chat and
 * check-in — depends on this interface only; the concrete transport is selected
 * once, when the runtime is assembled.
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderAccountInfo } from '../account.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from '../region.ts'
import type { QoderCheckInResult } from './checkin.ts'
import { DefaultQoderTransport } from './default-transport.ts'
import type { QoderLogger } from './logging.ts'

export type { QoderCheckInResult }

/** The Qoder service operations the provider depends on. */
export interface QoderTransport {
  /** Open one streaming chat completion against the service. */
  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk>
  /** Read the model directory the service serves to this credential. */
  discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]>
  /** Read the subscriber profile and quota answer behind this credential. */
  readAccount(options?: { force?: boolean | undefined; signal?: AbortSignal | undefined }): Promise<QoderAccountInfo>
  /** Claim today's campaign benefit. */
  checkIn(signal?: AbortSignal): Promise<QoderCheckInResult>
}

/** Everything the transport needs; only the region and credential resolver are required. */
export interface QoderTransportOptions {
  region: QoderRegion
  /**
   * The credential to sign with: a Personal Access Token (`pt-` prefix, which
   * is exchanged for a job token) or a desktop-imported device token (already
   * a job token, used as-is).
   */
  resolveAccessToken: () => Promise<string>
  /**
   * Rotate a desktop-imported device token after the upstream rejected it.
   * The store persists the rotated pair; absent for PAT-only setups.
   */
  refreshDeviceToken?: (() => Promise<string>) | undefined
  /** Force one credential kind instead of prefix detection (PAT validation). */
  credentialKind?: 'pat' | 'device' | undefined
  fetch?: typeof fetch
  logger?: QoderLogger
  /** Idle deadline while a chat stream is being consumed. */
  streamIdleTimeoutMs?: number
  /** Deadline for upstream response headers. */
  responseHeaderTimeoutMs?: number
  /** Deadline for the side reads (catalog, account, check-in). */
  metadataTimeoutMs?: number
  /** Stable device identity presented during the job-token exchange. */
  resolveMachineId?: () => string
  attachments?: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>
  /** Deadline for one image publication attempt. */
  imageUploadTimeoutMs?: number
  /** How long a published image reference may be reused. */
  imageUrlCacheTtlMs?: number
  /** Whether earlier assistant reasoning is replayed across turns. */
  preserveThinking?: boolean
  /** Called after a rejected job token was replaced and the retry accepted. */
  onJobTokenRefreshed?: (info: { region: QoderRegion; at: number }) => void
  /** Called when the replacement token was rejected too; at most once per outage. */
  onJobTokenRefreshFailed?: (info: { region: QoderRegion; at: number; status?: number }) => void
}

/** Build the transport for one service region. */
export function createQoderTransport(options: QoderTransportOptions): QoderTransport {
  return new DefaultQoderTransport(options)
}
