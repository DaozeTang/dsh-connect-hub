import { createHash } from 'node:crypto'
import { maskTail } from '../../core/redact.ts'
import type { Vault } from '../../core/vault.ts'
import type { QoderDesktopCredential, QoderDesktopUser, QoderDeviceRefreshOutcome } from './desktop-auth.ts'
import type { QoderVariant } from './variants.ts'

/** A manually saved Personal Access Token. */
export interface QoderPatCredential {
  kind: 'pat'
  pat: string
  savedAtMs?: number
}

/** A sign-in imported from the Qoder desktop app, with its rotation state. */
export interface QoderDeviceCredential {
  kind: 'device'
  token: string
  refreshToken: string
  expiresAtMs: number
  refreshTokenExpiresAtMs?: number
  user: QoderDesktopUser
  savedAtMs: number
  /** Provenance: imported from the desktop app (rotations keep it). */
  source: 'desktop'
}

/** The credential currently in effect. */
export type QoderCredential = QoderPatCredential | QoderDeviceCredential

/** Vault payload for a desktop-imported credential. */
interface StoredDeviceCredential {
  version: 2
  kind: 'device'
  token: string
  refreshToken: string
  expiresAtMs: number
  refreshTokenExpiresAtMs?: number
  user: QoderDesktopUser
  savedAt: number
}

/** PAT payload; version 1 is the only shape this plugin has written. */
interface StoredPatCredential {
  version: 1
  pat: string
  savedAt: number
}

/** Redacted credential facts `status()` is allowed to expose. */
export interface QoderCredentialSummary {
  configured: boolean
  kind?: 'pat' | 'device'
  masked?: string
  savedAtMs?: number
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  /** Desktop-imported account identity; absent for a PAT. */
  accountId?: string
  accountName?: string
  accountEmail?: string
}

export interface QoderCredentialStoreOptions {
  vault: Vault
  variant: QoderVariant
  /**
   * Rotates a desktop-imported token pair. Absent when rotation is not
   * available; the store then degrades to reporting the expiry honestly.
   */
  refresh?: (
    credential: QoderDeviceCredential,
    signal?: AbortSignal,
  ) => Promise<QoderDeviceRefreshOutcome>
  /** How long before expiry to rotate; default ten minutes. */
  refreshMarginMs?: number
}

const DEFAULT_REFRESH_MARGIN_MS = 10 * 60 * 1000
/** Grace after rotation failure during which the still-valid old token is used. */
const REFRESH_FAILURE_GRACE_MS = 30_000
/** How long a failed rotation is not retried, so an outage is not amplified. */
const REFRESH_FAILURE_COOLDOWN_MS = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function finiteMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

function parseUser(value: unknown): QoderDesktopUser {
  if (!isRecord(value)) return { id: '' }
  const id = nonEmpty(value['id']) ?? ''
  const name = nonEmpty(value['name'])
  const email = nonEmpty(value['email'])
  return {
    id,
    ...name === undefined ? {} : { name },
    ...email === undefined ? {} : { email },
  }
}

function parseDevice(value: Record<string, unknown>): QoderDeviceCredential | undefined {
  if (value['version'] !== 2 || value['kind'] !== 'device') return undefined
  const token = nonEmpty(value['token'])
  const refreshToken = nonEmpty(value['refreshToken'])
  if (token === undefined || refreshToken === undefined) return undefined
  const expiresAtMs = finiteMs(value['expiresAtMs']) ?? 0
  const refreshTokenExpiresAtMs = finiteMs(value['refreshTokenExpiresAtMs'])
  const savedAtMs = finiteMs(value['savedAt']) ?? Date.now()
  return {
    kind: 'device',
    token,
    refreshToken,
    expiresAtMs,
    ...refreshTokenExpiresAtMs === undefined ? {} : { refreshTokenExpiresAtMs },
    user: parseUser(value['user']),
    savedAtMs,
    source: 'desktop',
  }
}

/** Parse either persisted shape; unknown versions are ignored, never guessed. */
function parseStored(value: unknown): QoderCredential | undefined {
  if (!isRecord(value)) return undefined
  if (value['kind'] === 'device') return parseDevice(value)
  const pat = nonEmpty(value['pat'])
  if (pat === undefined) return undefined
  const savedAt = finiteMs(value['savedAt'])
  return {
    kind: 'pat',
    pat,
    ...savedAt === undefined ? {} : { savedAtMs: savedAt },
  }
}

function deviceDocument(credential: QoderDeviceCredential): StoredDeviceCredential {
  return {
    version: 2,
    kind: 'device',
    token: credential.token,
    refreshToken: credential.refreshToken,
    expiresAtMs: credential.expiresAtMs,
    ...credential.refreshTokenExpiresAtMs === undefined
      ? {}
      : { refreshTokenExpiresAtMs: credential.refreshTokenExpiresAtMs },
    user: credential.user,
    savedAt: credential.savedAtMs,
  }
}

function patDocument(pat: string, savedAt: number): StoredPatCredential {
  return { version: 1, pat, savedAt }
}

/**
 * The source of truth for one region's credential: the hub vault slot
 * (`qoder-cn` / `qoder-global`).
 *
 * A Personal Access Token reaches the slot only through the UI's validated
 * save action. A desktop-imported sign-in reaches it through the automatic
 * import (or the explicit re-read action); its rotated token pairs are written
 * back here, never to the Qoder app's own storage.
 */
export class QoderCredentialStore {
  private readonly vault: Vault
  private readonly variant: QoderVariant
  private readonly refresh: QoderCredentialStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private cached: QoderCredential | undefined
  private loaded = false
  private refreshFlight: Promise<QoderDeviceCredential> | undefined
  private refreshController: AbortController | undefined
  private lastRefreshErrorText: string | undefined
  private lastRefreshAttemptAt = 0
  /**
   * Bumped by every credential mutation. A rotation that resolves after the
   * user cleared the credential or saved another one must not resurrect or
   * overwrite it, so its write is gated on this generation.
   */
  private generation = 0
  /**
   * All credential writes are queued through this chain. Generation checks
   * alone cannot close the window between "about to write" and "write lands";
   * serializing them makes the last mutation win deterministically.
   */
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: QoderCredentialStoreOptions) {
    this.vault = options.vault
    this.variant = options.variant
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS
  }

  /** Read the vault-held credential into the cache. */
  async load(): Promise<QoderCredential | undefined> {
    if (this.loaded) return this.cached
    const stored = parseStored(await this.vault.read<unknown>(this.variant.slot))
    this.cached = stored
    this.loaded = true
    return this.cached
  }

  /** Re-read the vault; used by the credential sweep to notice external edits. */
  async reload(): Promise<QoderCredential | undefined> {
    this.loaded = false
    return this.load()
  }

  /** Credential currently in effect, from the cache. */
  current(): QoderCredential | undefined {
    return this.cached
  }

  /**
   * Credential identity used for catalog caches. A rotating device token must
   * not look like a new account, so the desktop account id is the identity;
   * PATs keep their one-way token hash.
   */
  identity(): string | undefined {
    const credential = this.cached
    if (credential === undefined) return undefined
    if (credential.kind === 'pat') {
      return `pat:${createHash('sha256').update(credential.pat).digest('hex').slice(0, 16)}`
    }
    const account = credential.user.id !== ''
      ? credential.user.id
      : createHash('sha256').update(credential.refreshToken).digest('hex').slice(0, 16)
    return `device:${account}`
  }

  /** The access token to sign with, rotated before it expires. */
  async accessToken(): Promise<string> {
    // Retry when a concurrent save/clear lands between the load and the
    // rotation: the generation check keeps a stale credential from signing.
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = this.generation
      const credential = await this.load()
      if (this.generation !== generation) continue
      if (credential === undefined) {
        throw new Error(
          'MISSING_CREDENTIAL: 尚未登录 Qoder；请先在 Qoder 桌面端登录一次，或填写 PAT',
        )
      }
      if (credential.kind === 'pat') return credential.pat
      if (credential.refreshToken === ''
        && credential.expiresAtMs > 0
        && credential.expiresAtMs <= Date.now()) {
        throw new Error('MISSING_CREDENTIAL: Qoder 桌面端登录已过期且没有刷新令牌，请在 Qoder 桌面端重新登录或在本页重新读取')
      }
      if (!this.needsRefresh(credential)) return credential.token
      if (this.lastRefreshErrorText !== undefined
        && Date.now() - this.lastRefreshAttemptAt < REFRESH_FAILURE_COOLDOWN_MS) {
        // A recent rotation already failed; do not turn an outage into a
        // request storm. A still-valid token stays usable, an expired one
        // fails closed.
        if (credential.expiresAtMs > Date.now()) return credential.token
        throw new Error(`MISSING_CREDENTIAL: Qoder 桌面端登录已过期（${this.lastRefreshErrorText}）`)
      }
      try {
        const refreshed = await this.refreshDevice(credential, generation)
        return refreshed.token
      } catch (error: unknown) {
        // A concurrent save/clear invalidated this rotation; retry the load
        // instead of surfacing a confusing "credential changed" error.
        if (this.generation !== generation) continue
        throw error
      }
    }
    throw new Error('MISSING_CREDENTIAL: Qoder 凭据正在变更，请重试')
  }

  /**
   * Rotate the current device token pair and persist it, regardless of the
   * expiry margin. Used by the transport's self-heal when the upstream rejects
   * a token earlier than the clock predicted.
   */
  async rotate(): Promise<string> {
    const generation = this.generation
    const credential = await this.load()
    if (this.generation !== generation) {
      throw new Error('MISSING_CREDENTIAL: Qoder 凭据正在变更，请重试')
    }
    if (credential === undefined || credential.kind !== 'device') {
      throw new Error('MISSING_CREDENTIAL: 当前 Qoder 凭据不是桌面端登录，无法自动续期')
    }
    const refreshed = await this.refreshDevice(credential, generation)
    return refreshed.token
  }

  /** Credential presence for the loopback shim, which only needs the failure. */
  async resolve(): Promise<QoderCredential> {
    const credential = await this.load()
    if (credential === undefined) {
      throw new Error('MISSING_CREDENTIAL: 尚未登录 Qoder')
    }
    return credential
  }

  /** Persist a token the caller has already validated against the region. */
  async savePat(pat: string): Promise<QoderCredential> {
    const trimmed = pat.trim()
    if (trimmed === '') throw new Error('cannot save an empty Qoder Personal Access Token')
    // Install the new credential synchronously: an in-flight rotation must see
    // the change even while the vault write below is still pending.
    this.generation += 1
    this.refreshController?.abort('credential replaced')
    this.refreshController = undefined
    this.refreshFlight = undefined
    const savedAt = Date.now()
    const credential: QoderPatCredential = { kind: 'pat', pat: trimmed, savedAtMs: savedAt }
    this.cached = credential
    this.loaded = true
    this.resetRotationState()
    const writeGeneration = this.generation
    try {
      await this.enqueueWrite(async () => {
        if (this.generation !== writeGeneration) return
        await this.vault.write<StoredPatCredential>(this.variant.slot, patDocument(trimmed, savedAt))
      })
    } catch (error: unknown) {
      // The vault still holds whatever was there before; restore the cache from
      // it instead of claiming the (failed) new credential is active. A later
      // mutation owns the state when one landed during this failed write.
      if (this.generation === writeGeneration) {
        this.loaded = false
        await this.load().catch(() => undefined)
      }
      throw error
    }
    return credential
  }

  /** Persist an explicitly imported desktop sign-in. */
  async saveDevice(imported: QoderDesktopCredential): Promise<QoderDeviceCredential> {
    const credential = this.deviceFromImported(imported)
    this.generation += 1
    this.refreshController?.abort('credential replaced')
    this.refreshController = undefined
    this.refreshFlight = undefined
    this.cached = credential
    this.loaded = true
    this.resetRotationState()
    const writeGeneration = this.generation
    try {
      await this.enqueueWrite(async () => {
        if (this.generation !== writeGeneration) return
        await this.vault.write<StoredDeviceCredential>(this.variant.slot, deviceDocument(credential))
      })
    } catch (error: unknown) {
      if (this.generation === writeGeneration) {
        this.loaded = false
        await this.load().catch(() => undefined)
      }
      throw error
    }
    return credential
  }

  /**
   * Adopt a desktop record read by the sweep when it is genuinely newer: the
   * same account rotated by the app, or a different account signed in there.
   * A stale desktop record never replaces a hub-rotated pair.
   */
  async mergeDesktop(imported: QoderDesktopCredential): Promise<boolean> {
    const credential = await this.load()
    if (credential === undefined || credential.kind !== 'device') return false
    // An anonymous record cannot prove it belongs to the account already in
    // use, so it must not replace it.
    if (imported.user.id === '' && credential.user.id !== '') return false
    const sameAccount = credential.user.id !== '' && imported.user.id === credential.user.id
    if (!sameAccount) {
      await this.saveDevice(imported)
      return true
    }
    if (imported.token === credential.token) return false
    if (imported.expiresAtMs <= credential.expiresAtMs + 60_000) return false
    await this.saveDevice(imported)
    return true
  }

  /** Remove the stored credential; a missing one is not an error. */
  async clear(): Promise<void> {
    // Invalidate the cache synchronously, before the await: a concurrent
    // reader must not keep signing with (or rotating) a credential the user is
    // clearing right now.
    this.generation += 1
    this.refreshController?.abort('credential cleared')
    this.refreshController = undefined
    this.refreshFlight = undefined
    this.cached = undefined
    this.loaded = true
    this.resetRotationState()
    const writeGeneration = this.generation
    await this.enqueueWrite(async () => {
      if (this.generation !== writeGeneration) return
      await this.vault.remove(this.variant.slot)
    })
  }

  /** Why the last proactive rotation failed, or undefined when healthy. */
  lastRefreshError(): string | undefined {
    return this.lastRefreshErrorText
  }

  /** Synchronous redacted summary for `status()`. */
  summary(): QoderCredentialSummary {
    const credential = this.cached
    if (credential === undefined) return { configured: false }
    const masked = maskTail(credential.kind === 'pat' ? credential.pat : credential.token)
    if (credential.kind === 'pat') {
      return {
        configured: true,
        kind: 'pat',
        ...masked === undefined ? {} : { masked },
        ...credential.savedAtMs === undefined ? {} : { savedAtMs: credential.savedAtMs },
      }
    }
    return {
      configured: true,
      kind: 'device',
      ...masked === undefined ? {} : { masked },
      savedAtMs: credential.savedAtMs,
      ...credential.expiresAtMs > 0 ? { expiresAtMs: credential.expiresAtMs } : {},
      ...credential.refreshTokenExpiresAtMs === undefined
        ? {}
        : { refreshExpiresAtMs: credential.refreshTokenExpiresAtMs },
      ...credential.user.id === '' ? {} : { accountId: credential.user.id },
      ...credential.user.name === undefined ? {} : { accountName: credential.user.name },
      ...credential.user.email === undefined ? {} : { accountEmail: credential.user.email },
    }
  }

  private deviceFromImported(imported: QoderDesktopCredential): QoderDeviceCredential {
    return {
      kind: 'device',
      token: imported.token,
      refreshToken: imported.refreshToken,
      expiresAtMs: imported.expiresAtMs,
      ...imported.refreshTokenExpiresAtMs === undefined
        ? {}
        : { refreshTokenExpiresAtMs: imported.refreshTokenExpiresAtMs },
      user: imported.user,
      savedAtMs: Date.now(),
      source: 'desktop',
    }
  }

  private needsRefresh(credential: QoderDeviceCredential): boolean {
    if (credential.refreshToken === '') return false
    if (credential.expiresAtMs <= 0) return false
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  /** Single-flight rotation; concurrent readers share one upstream call. */
  private async refreshDevice(
    credential: QoderDeviceCredential,
    generation: number,
  ): Promise<QoderDeviceCredential> {
    if (this.refresh === undefined) {
      if (credential.expiresAtMs > Date.now() + REFRESH_FAILURE_GRACE_MS) return credential
      throw new Error('MISSING_CREDENTIAL: Qoder 桌面端登录已过期，请在 Qoder 桌面端重新登录或在本页重新读取')
    }
    // Every caller joins the in-flight rotation: a second refresh with the same
    // refresh token would race the first and, with a single-use token, one of
    // the two would fail for no reason.
    const existing = this.refreshFlight
    if (existing !== undefined) return await existing
    const controller = new AbortController()
    this.refreshController = controller
    this.lastRefreshAttemptAt = Date.now()
    let flight: Promise<QoderDeviceCredential>
    flight = this.rotateNow(credential, generation, controller.signal).finally(() => {
      if (this.refreshFlight === flight) this.refreshFlight = undefined
      if (this.refreshController === controller) this.refreshController = undefined
    })
    this.refreshFlight = flight
    return await flight
  }

  private async rotateNow(
    credential: QoderDeviceCredential,
    generation: number,
    signal: AbortSignal,
  ): Promise<QoderDeviceCredential> {
    try {
      const outcome = await this.refresh!(credential, signal)
      if (this.generation !== generation) {
        // The credential was cleared or replaced while this rotation was in
        // flight; its result belongs to a credential that is no longer current.
        throw new Error(this.cached === undefined
          ? 'MISSING_CREDENTIAL: Qoder 登录已在此次自动续期期间被清除'
          : 'MISSING_CREDENTIAL: Qoder 凭据已在此次自动续期期间变更，请重试')
      }
      const refreshed: QoderDeviceCredential = {
        kind: 'device',
        token: outcome.token,
        refreshToken: outcome.refreshToken,
        expiresAtMs: outcome.expiresAtMs > 0 ? outcome.expiresAtMs : Date.now() + 24 * 60 * 60 * 1000,
        ...outcome.refreshTokenExpiresAtMs === undefined
          ? credential.refreshTokenExpiresAtMs === undefined ? {} : { refreshTokenExpiresAtMs: credential.refreshTokenExpiresAtMs }
          : { refreshTokenExpiresAtMs: outcome.refreshTokenExpiresAtMs },
        user: credential.user,
        savedAtMs: Date.now(),
        source: 'desktop',
      }
      await this.enqueueWrite(async () => {
        if (this.generation !== generation) return
        await this.vault.write<StoredDeviceCredential>(this.variant.slot, deviceDocument(refreshed))
        // A mutation that landed while the write was pending has already
        // installed its own state; publishing the rotation would resurrect it.
        if (this.generation !== generation) return
        this.generation += 1
        this.cached = refreshed
        this.loaded = true
        this.lastRefreshErrorText = undefined
      })
      const current = this.cached
      if (current === undefined || current.kind !== 'device' || current.token !== refreshed.token) {
        throw new Error(this.cached === undefined
          ? 'MISSING_CREDENTIAL: Qoder 登录已在此次自动续期期间被清除'
          : 'MISSING_CREDENTIAL: Qoder 凭据已在此次自动续期期间变更，请重试')
      }
      return refreshed
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.generation !== generation) throw error
      this.lastRefreshErrorText = message
      if (credential.expiresAtMs > Date.now() + REFRESH_FAILURE_GRACE_MS) return credential
      throw new Error(`MISSING_CREDENTIAL: Qoder 桌面端登录已过期（${message}）`)
    }
  }

  /** Run a vault mutation after every earlier one; failures do not break the chain. */
  private async enqueueWrite(work: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(work, work)
    this.writeQueue = run.then(() => undefined, () => undefined)
    await run
  }

  private resetRotationState(): void {
    this.lastRefreshErrorText = undefined
    this.lastRefreshAttemptAt = 0
  }
}
