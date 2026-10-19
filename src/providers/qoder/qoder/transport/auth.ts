/** PAT exchange and in-memory Qoder job-token lifecycle. */

import type { CosyCredentials } from './wire/cosy.ts'
import { getQoderExchangeUrl, type QoderRegion } from './endpoints.ts'
import { QoderLlmError } from '../errors.ts'
import type { QoderLogger } from './logging.ts'
import { getMachineId } from './machine-id.ts'
import {
  opaqueCredentialKey,
  openApiJsonRequest,
  retryMetadataRead,
} from './request.ts'
import { fetchQoderUserInfo } from './user-info.ts'

const expiryBufferMs = 5 * 60 * 1000
const defaultExpiryMs = 24 * 60 * 60 * 1000
const defaultAuthTimeoutMs = 15_000
/**
 * How long a device-token profile read is reused. The token itself is resolved
 * per request by the credential store; this cache only avoids repeating the
 * identity lookup on every chat turn.
 */
const directCredentialCacheMs = 30 * 60 * 1000

/** Personal Access Tokens carry this prefix; every other token is a device token. */
const PERSONAL_ACCESS_TOKEN_PREFIX = 'pt-'

/** Whether a credential is exchanged for a job token, or already is one. */
export function isPersonalAccessToken(credential: string): boolean {
  return credential.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)
}

interface CachedEntry {
  creds: CosyCredentials
  expiresAt: number
}

interface InFlightEntry {
  promise: Promise<CosyCredentials>
  controller: AbortController
  waiters: number
  settled: boolean
  timeout: ReturnType<typeof setTimeout>
}

interface HealFlightEntry {
  promise: Promise<CosyCredentials>
  settled: boolean
}

export interface QoderAuthServiceOptions {
  fetch?: typeof fetch | undefined
  timeoutMs?: number | undefined
  resolveMachineId?: (() => string) | undefined
  region?: QoderRegion | undefined
  logger?: QoderLogger | undefined
  /**
   * Rotate a desktop-imported device token after the upstream rejected it.
   * Absent when the credential did not come from a desktop sign-in.
   */
  refreshDeviceToken?: (() => Promise<string>) | undefined
  /**
   * Force one credential kind instead of detecting it from the prefix. Token
   * validation always receives a PAT even when a fixture does not use the real
   * `pt-` prefix.
   */
  credentialKind?: 'pat' | 'device' | undefined
}

function abortedError(): QoderLlmError {
  return new QoderLlmError('Qoder authentication was aborted.', 'ABORTED')
}

async function waitForFlight(
  promise: Promise<CosyCredentials>,
  signal?: AbortSignal,
): Promise<CosyCredentials> {
  if (signal === undefined) return promise
  if (signal.aborted) throw abortedError()

  return new Promise<CosyCredentials>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export class QoderAuthService {
  private readonly cache = new Map<string, CachedEntry>()
  private readonly inFlight = new Map<string, InFlightEntry>()
  /**
   * Self-heal exchanges in flight, keyed like the cache. Deliberately separate
   * from {@link inFlight}: that flight may be aborted by a departing
   * concurrent waiter (a quota poll, a catalog sweep) whose abort has nothing
   * to do with the heal, so healers must not share its controller. Concurrent
   * heals instead share this flight — see {@link exchangeFresh}.
   */
  private readonly healFlights = new Map<string, HealFlightEntry>()
  /** Shared profile reads for device tokens; one lookup per concurrent burst. */
  private readonly directFlights = new Map<string, Promise<CosyCredentials>>()
  private readonly refreshDeviceToken: (() => Promise<string>) | undefined
  private readonly credentialKind: 'pat' | 'device' | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly resolveMachineId: () => string
  private readonly region: QoderRegion
  private readonly logger: QoderLogger | undefined
  constructor(options: QoderAuthServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? defaultAuthTimeoutMs
    // The same default chain every other caller gets: the official Qoder
    // CLI's id first, this plugin's own data-directory seed as the create
    // point — never a file under the OS home directory.
    this.resolveMachineId = options.resolveMachineId ?? getMachineId
    this.region = options.region ?? 'global'
    this.logger = options.logger
    this.refreshDeviceToken = options.refreshDeviceToken
    this.credentialKind = options.credentialKind
  }

  /** Whether a credential is a device token that needs no job-token exchange. */
  private isDeviceToken(credential: string): boolean {
    if (this.credentialKind !== undefined) return this.credentialKind === 'device'
    return !isPersonalAccessToken(credential)
  }

  clear(credential?: string): void {
    if (credential) {
      const key = `${this.region}:${opaqueCredentialKey(credential)}`
      this.cache.delete(key)
      this.directFlights.delete(key)
    } else {
      this.cache.clear()
      this.directFlights.clear()
    }
  }

  /**
   * Replace a credential the upstream started rejecting, for the self-heal
   * retry, outside the shared single-flight.
   *
   * The shared flight can be aborted by a departing concurrent waiter (the
   * quota poll, the catalog sweep), and a retry that joins it would then be
   * cancelled by a path that has nothing to do with the chat. For a PAT this
   * re-exchanges; for a desktop-imported device token it rotates the pair
   * through the credential store and resolves the new token's identity.
   *
   * Two heals for the same credential that overlap share one exchange instead
   * of racing: each racer's `clear` deleted what the previous one had just
   * cached, and its own `cache.set` overwrote the other's — so the cache could
   * end up naming a token the losing request was no longer using, and with an
   * upstream that retires the previous job token on a new exchange the racers
   * also invalidated each other's credentials (one chat recovering while a
   * concurrent one failed). The
   * shared exchange runs on its own timeout signal, so one healer's abort —
   * its chat request went away — cannot cancel an exchange other healers, and
   * the future `getCredentials` callers about to read the refreshed cache, are
   * waiting on.
   */
  async exchangeFresh(credential: string, signal?: AbortSignal): Promise<CosyCredentials> {
    if (this.isDeviceToken(credential)) {
      if (this.refreshDeviceToken === undefined) {
        throw new QoderLlmError(
          'Qoder desktop sign-in cannot be rotated automatically; re-read it in the hub settings.',
          'AUTH',
        )
      }
      const rotated = (await this.refreshDeviceToken()).trim()
      if (rotated === '') {
        throw new QoderLlmError('Qoder desktop sign-in rotation returned no token.', 'AUTH')
      }
      this.clear(credential)
      return await this.directCredentials(rotated, signal)
    }
    const cacheKey = `${this.region}:${opaqueCredentialKey(credential)}`
    const existing = this.healFlights.get(cacheKey)
    if (existing !== undefined && !existing.settled) {
      return waitForFlight(existing.promise, signal)
    }
    this.clear(credential)
    const created = { settled: false } as HealFlightEntry
    created.promise = this.exchangeAndResolve(credential, AbortSignal.timeout(this.timeoutMs)).finally(() => {
      created.settled = true
      if (this.healFlights.get(cacheKey) === created) this.healFlights.delete(cacheKey)
    })
    this.healFlights.set(cacheKey, created)
    return waitForFlight(created.promise, signal)
  }

  async getCredentials(
    credential: string,
    signal?: AbortSignal,
  ): Promise<CosyCredentials> {
    if (!credential || typeof credential !== 'string') {
      throw new QoderLlmError(
        'Qoder credential is missing. Connect Qoder in the hub settings page.',
        'MISSING_CREDENTIAL',
      )
    }
    if (signal?.aborted) throw abortedError()

    const cacheKey = `${this.region}:${opaqueCredentialKey(credential)}`

    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() + expiryBufferMs) return cached.creds

    // A desktop device token is already the job token the gateway takes, so
    // the only upstream work left is resolving the account identity.
    if (this.isDeviceToken(credential)) {
      return await this.directCredentials(credential, signal)
    }

    let entry = this.inFlight.get(cacheKey)
    if (entry === undefined || entry.controller.signal.aborted) {
      const controller = new AbortController()
      const created = {} as InFlightEntry
      created.controller = controller
      created.waiters = 0
      created.settled = false
      created.timeout = setTimeout(() => controller.abort('authentication timeout'), this.timeoutMs)
      created.promise = this.exchangeAndResolve(credential, controller.signal).finally(() => {
        created.settled = true
        clearTimeout(created.timeout)
        if (this.inFlight.get(cacheKey) === created) this.inFlight.delete(cacheKey)
      })
      entry = created
      this.inFlight.set(cacheKey, entry)
    }

    entry.waiters++
    try {
      return await waitForFlight(entry.promise, signal)
    } finally {
      entry.waiters--
      if (entry.waiters === 0 && !entry.settled) {
        if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey)
        entry.controller.abort('all callers aborted')
      }
    }
  }

  /** Resolve a device token's identity, sharing one profile read per burst. */
  private directCredentials(token: string, signal?: AbortSignal): Promise<CosyCredentials> {
    const cacheKey = `${this.region}:${opaqueCredentialKey(token)}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() + expiryBufferMs) return Promise.resolve(cached.creds)
    const existing = this.directFlights.get(cacheKey)
    if (existing !== undefined) return waitForFlight(existing, signal)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('authentication timeout'), this.timeoutMs)
    let flight: Promise<CosyCredentials>
    flight = this.resolveDirect(token, cacheKey, controller.signal).finally(() => {
      clearTimeout(timeout)
      if (this.directFlights.get(cacheKey) === flight) this.directFlights.delete(cacheKey)
    })
    this.directFlights.set(cacheKey, flight)
    return waitForFlight(flight, signal)
  }

  private async resolveDirect(
    token: string,
    cacheKey: string,
    signal: AbortSignal,
  ): Promise<CosyCredentials> {
    const userInfo = await retryMetadataRead(signal, () => fetchQoderUserInfo({
      region: this.region,
      token,
      signal,
      timeoutMs: this.timeoutMs,
      fetch: this.fetchImpl,
      ...this.logger === undefined ? {} : { logger: this.logger },
    }))
    const creds: CosyCredentials = {
      userID: userInfo.userID,
      authToken: token,
      name: userInfo.name || 'Qoder User',
      email: userInfo.email,
      machineID: this.resolveMachineId(),
    }
    this.cache.set(cacheKey, { creds, expiresAt: Date.now() + directCredentialCacheMs })
    return creds
  }

  private async exchangeAndResolve(
    pat: string,
    signal: AbortSignal,
  ): Promise<CosyCredentials> {
    let jobToken: string
    let expiresAt = Date.now() + defaultExpiryMs

    const data = await openApiJsonRequest<{ token?: string; expires_at?: string; expires_in?: number }>(
      this.fetchImpl,
      {
        url: getQoderExchangeUrl(this.region),
        body: { personal_token: pat },
        signal,
        timeoutMs: this.timeoutMs,
        logger: this.logger,
        operation: 'Auth',
        logCategory: 'auth.exchange',
      },
    )
    if (!data.token) {
      throw new QoderLlmError('Qoder PAT exchange returned no job token.', 'AUTH')
    }
    jobToken = data.token
    if (data.expires_at) {
      const parsed = Date.parse(data.expires_at)
      if (!Number.isNaN(parsed)) expiresAt = parsed
    } else if (typeof data.expires_in === 'number' && data.expires_in > 0) {
      expiresAt = Date.now() + data.expires_in
    }

    const userInfo = await retryMetadataRead(signal, () => fetchQoderUserInfo({
      region: this.region,
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      fetch: this.fetchImpl,
      ...this.logger === undefined ? {} : { logger: this.logger },
    }))
    const creds: CosyCredentials = {
      userID: userInfo.userID,
      authToken: jobToken,
      name: userInfo.name || 'Qoder User',
      email: userInfo.email,
      machineID: this.resolveMachineId(),
    }
    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`
    this.cache.set(cacheKey, { creds, expiresAt })
    return creds
  }
}
