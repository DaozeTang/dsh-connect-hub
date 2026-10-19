import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { SecretSlot } from '../../core/vault.ts'
import { parseTraeCliToken, parseTraeStorageDocument } from './decrypt.ts'
import { traeStorageCandidates, type TraeCredentialSource, type TraeEdition, type TraeStorageCandidate } from './paths.ts'
import { regionOfCredential, regionOfEdition, type TraeRegion } from './region.ts'

export interface TraeCredential {
  accessToken: string
  refreshToken?: string
  userId: string
  accountName?: string
  host: string
  /** Region claim from the storage document (`userRegion.region`, 'CN' | 'SG'). */
  userRegion?: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  edition: TraeEdition
  source: 'desktop' | 'dsh' | 'cli'
  /** Set by the account-transfer import: no local app sign-in backs this row. */
  imported?: boolean
}

export interface TraeRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  host?: string
}

/**
 * Where the provider-owned credential copies live. The hub backs this with its
 * vault slots (`trae-cn` / `trae-global`); tests inject a memory store.
 */
export interface TraeCredentialPersistence {
  /** Every provider-owned credential of this store's region. */
  read(): Promise<TraeCredential[]>
  /** Replace the whole provider-owned set of this region. */
  write(credentials: readonly TraeCredential[]): Promise<void>
  /** Atomic read-modify-write over the provider-owned set. */
  update(mutate: (current: readonly TraeCredential[]) => readonly TraeCredential[]): Promise<void>
}

export interface TraeCredentialStoreOptions {
  storagePath?: string
  edition?: TraeEdition | 'auto'
  accountId?: string
  /**
   * Region this store serves. When set, only credentials whose own claim maps
   * to this region are discovered, selected, or refreshed.
   */
  region?: TraeRegion
  persist: TraeCredentialPersistence
  refresh: (credential: TraeCredential) => Promise<TraeRefreshOutcome>
  refreshMarginMs?: number
}

export interface TraeAccountChoice {
  id: string
  accountName: string
  edition: TraeEdition
  /** Routing bucket of this account (`cn` | `ai`), derived from its credential. */
  region: TraeRegion
  source: 'desktop' | 'dsh' | 'cli'
  tokenExpiresAtMs: number
  refreshExpiresAtMs?: number
  selected: boolean
}

export interface TraeCandidateFailure {
  path: string
  edition: TraeEdition
  source: TraeCredentialSource
  reason: 'missing' | 'unreadable' | 'invalid'
  message?: string
}

/** Host used for CLI tokens, which carry no host claim of their own. */
const CLI_DEFAULT_HOST = 'https://api.trae.cn'

/** On-disk format of the per-region vault payload. */
const OWN_VERSION = 2
const OWN_VERSION_SINGLE = 1

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function timeToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Extract the `userRegion.region` string from either on-disk shape. */
function userRegionOf(value: unknown): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

export function normalizeTraeCredential(
  raw: unknown,
  edition: TraeEdition,
  source: TraeCredential['source'],
): TraeCredential | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const accessToken = optionalString(value['token']) ?? optionalString(value['accessToken'])
  if (accessToken === undefined) return undefined
  const expiresAtMs = timeToMs(value['expiredAt'] ?? value['expiresAt']) ?? 0
  const refreshExpiresAtMs = timeToMs(value['refreshExpiredAt'] ?? value['refreshExpiresAt'])
  const refreshToken = optionalString(value['refreshToken'])
  const userRegion = userRegionOf(value['userRegion'])
  const account = typeof value['account'] === 'object' && value['account'] !== null && !Array.isArray(value['account'])
    ? value['account'] as Record<string, unknown>
    : undefined
  const accountName = optionalString(account?.['username'])
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    userId: optionalString(value['userId']) ?? '',
    ...accountName === undefined ? {} : { accountName },
    host: optionalString(value['host']) ?? '',
    ...userRegion === undefined ? {} : { userRegion },
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    edition,
    source,
  }
}

export function traeAccountId(credential: Pick<TraeCredential, 'edition' | 'userId' | 'accountName'>): string {
  const stable = `${credential.edition}\0${credential.userId || credential.accountName || 'unknown'}`
  return createHash('sha256').update(stable).digest('hex').slice(0, 24)
}

/** One stored credential, validated. Returns undefined for a malformed row. */
function credentialOfStored(stored: unknown): TraeCredential | undefined {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined
  const record = stored as Record<string, unknown>
  const edition = record['edition']
  if (edition !== 'cn' && edition !== 'sg' && edition !== 'solo' && edition !== 'solo-sg') return undefined
  const normalized = normalizeTraeCredential({
    token: record['accessToken'],
    refreshToken: record['refreshToken'],
    userId: record['userId'],
    host: record['host'],
    userRegion: record['userRegion'],
    account: record['accountName'] === undefined ? undefined : { username: record['accountName'] },
    expiredAt: record['expiresAtMs'],
    refreshExpiredAt: record['refreshExpiresAtMs'],
  }, edition, 'dsh')
  if (normalized === undefined) return undefined
  return record['imported'] === true ? { ...normalized, imported: true } : normalized
}

/**
 * Read a provider-owned payload into its stored credentials. Accepts the current
 * version-2 array layout and the superseded single-credential version 1; a
 * malformed row is dropped rather than failing the whole file.
 */
export function parseTraeOwnDocument(value: unknown): TraeCredential[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const document = value as { version?: unknown; credential?: unknown; credentials?: unknown }
  if (document.version === OWN_VERSION) {
    if (!Array.isArray(document.credentials)) return []
    return document.credentials.map(credentialOfStored).filter((item): item is TraeCredential => item !== undefined)
  }
  if (document.version === OWN_VERSION_SINGLE) {
    const single = credentialOfStored(document.credential)
    return single === undefined ? [] : [single]
  }
  return []
}

/** Serialize the current version-2 payload. */
export function serializeTraeOwnDocument(credentials: readonly TraeCredential[]): Record<string, unknown> {
  return { version: OWN_VERSION, credentials: credentials.map(credential => ({ ...credential })) }
}

/** The vault operations this persistence uses; structural so tests can fake it. */
export interface TraeCredentialVault {
  read<T>(slot: SecretSlot): Promise<T | undefined>
  write<T>(slot: SecretSlot, value: T): Promise<void>
  modify<T>(
    slot: SecretSlot,
    mutate: (current: T | undefined) => Promise<T | undefined> | T | undefined,
  ): Promise<T | undefined>
}

/**
 * Vault-backed persistence for this provider's refreshed credential copies.
 * Each hub vault slot (`trae-cn` / `trae-global`) holds one region's accounts.
 */
export class VaultTraeCredentialPersistence implements TraeCredentialPersistence {
  constructor(
    private readonly vault: TraeCredentialVault,
    private readonly slot: SecretSlot,
  ) {}

  private async load(): Promise<TraeCredential[]> {
    return parseTraeOwnDocument(await this.vault.read(this.slot))
  }

  async read(): Promise<TraeCredential[]> {
    return this.load()
  }

  async write(credentials: readonly TraeCredential[]): Promise<void> {
    await this.vault.write(this.slot, serializeTraeOwnDocument(credentials))
  }

  async update(mutate: (current: readonly TraeCredential[]) => readonly TraeCredential[]): Promise<void> {
    // Atomic read-modify-write over this region's provider-owned credential set.
    await this.vault.modify<Record<string, unknown>>(this.slot, (current) =>
      serializeTraeOwnDocument(mutate(parseTraeOwnDocument(current))))
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TraeCredentialStore {
  private storagePathOverride: string | undefined
  private edition: TraeEdition | 'auto'
  private accountId: string | undefined
  private readonly region: TraeRegion | undefined
  private readonly persist: TraeCredentialPersistence
  private readonly refresh: TraeCredentialStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private inflight: Promise<TraeCredential> | undefined

  constructor(options: TraeCredentialStoreOptions) {
    this.storagePathOverride = options.storagePath
    this.edition = options.edition ?? 'auto'
    this.accountId = options.accountId
    this.region = options.region
    this.persist = options.persist
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60_000
  }

  /** Whether a credential's own claim belongs to this store's region. */
  private matchesRegion(credential: TraeCredential): boolean {
    return this.region === undefined || regionOfCredential(credential) === this.region
  }

  setSource(storagePath: string | undefined, edition: TraeEdition | 'auto' = 'auto', accountId?: string): void {
    this.storagePathOverride = storagePath
    this.edition = edition
    this.accountId = accountId
    this.inflight = undefined
  }

  selectAccount(accountId: string | undefined): void {
    this.accountId = accountId
    this.inflight = undefined
  }

  candidates(): TraeStorageCandidate[] {
    if (this.storagePathOverride !== undefined) {
      const edition = this.edition === 'auto' ? 'cn' : this.edition
      return [
        { edition, path: this.storagePathOverride, source: 'desktop' },
        { edition, path: this.storagePathOverride, source: 'cli' },
      ]
    }
    const all = traeStorageCandidates()
    // Every desktop edition is discovered (routing follows the credential's own
    // region); only the CN CLI home is probed because the international CLI
    // token carries no host claim this provider can route.
    const cliEdition: TraeEdition = 'cn'
    return this.edition === 'auto'
      ? all.filter(candidate => candidate.source === 'desktop' || candidate.edition === cliEdition)
      : all.filter(candidate => candidate.edition === this.edition
        && (candidate.source === 'desktop' || candidate.edition === cliEdition))
  }

  /**
   * Deterministic default when no account is explicitly selected: the account
   * the Trae desktop app is signed in to right now, else the first discovered.
   * Never credit-seeking.
   */
  private preferred(credentials: TraeCredential[]): TraeCredential | undefined {
    return credentials.find(credential => credential.source === 'desktop') ?? credentials[0]
  }

  /**
   * The account the Trae app is signed in to right now, when that differs from
   * the bound one. A pure read: the binding never moves from here.
   */
  async liveLogin(): Promise<TraeAccountChoice | undefined> {
    if (this.accountId === undefined || this.accountId === '') return undefined
    const credentials = await this.readAll()
    const live = this.preferred(credentials)
    if (live === undefined) return undefined
    const liveId = traeAccountId(live)
    if (liveId === this.accountId) return undefined
    return {
      id: liveId,
      accountName: live.accountName ?? (live.userId || `${live.edition} account`),
      edition: live.edition,
      region: regionOfCredential(live),
      source: live.source,
      tokenExpiresAtMs: live.expiresAtMs,
      ...live.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: live.refreshExpiresAtMs },
      selected: false,
    }
  }

  async accounts(): Promise<TraeAccountChoice[]> {
    const credentials = await this.readAll()
    const selectedExists = this.accountId !== undefined
      && credentials.some(credential => traeAccountId(credential) === this.accountId)
    const defaultSelected = this.preferred(credentials)
    return credentials.map(credential => ({
      id: traeAccountId(credential),
      accountName: credential.accountName ?? (credential.userId || `${credential.edition} account`),
      edition: credential.edition,
      region: regionOfCredential(credential),
      source: credential.source,
      tokenExpiresAtMs: credential.expiresAtMs,
      ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
      selected: selectedExists ? traeAccountId(credential) === this.accountId : credential === defaultSelected,
    }))
  }

  async current(): Promise<TraeCredential | undefined> {
    const credentials = await this.readAll()
    if (this.accountId === undefined) return this.preferred(credentials)
    // A saved account can disappear when Trae replaces its local login. Do NOT
    // silently fall back: that would bill an account the user did not select.
    return credentials.find(credential => traeAccountId(credential) === this.accountId)
  }

  /** Read one specific account's stored credential without changing the binding. */
  async credentialOf(accountId: string): Promise<TraeCredential | undefined> {
    if (accountId === '') return undefined
    const credentials = await this.readAll()
    return credentials.find(credential => traeAccountId(credential) === accountId)
  }

  /**
   * Store imported credentials, replacing any entry with the same account id
   * and leaving every other entry alone. Imported credentials have no desktop
   * file behind them, so this must be additive rather than a refresh-style
   * whole-document write.
   */
  async importAccounts(credentials: readonly Omit<TraeCredential, 'source'>[]): Promise<string[]> {
    if (credentials.length === 0) return []
    const written: string[] = []
    await this.persist.update(current => {
      const byId = new Map<string, TraeCredential>()
      for (const item of current) byId.set(traeAccountId(item), item)
      for (const credential of credentials) {
        const stored: TraeCredential = { ...credential, source: 'dsh', imported: true }
        const id = traeAccountId(stored)
        byId.set(id, stored)
        written.push(id)
      }
      return [...byId.values()]
    })
    if (written.length > 0) {
      this.accountId = written[written.length - 1]
      this.inflight = undefined
    }
    return written
  }

  async resolve(): Promise<TraeCredential> {
    const credential = await this.current()
    if (credential === undefined) throw new Error('未找到 Trae 登录账号')
    if (credential.expiresAtMs > Date.now() + this.refreshMarginMs) return credential
    this.inflight ??= this.refreshNow(credential).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  async desktopFilePresent(): Promise<boolean> {
    for (const candidate of this.candidates()) {
      try { if ((await stat(candidate.path)).isFile()) return true } catch { /* missing */ }
    }
    return false
  }

  /** Every local credential of this store's region, deduplicated by account id. */
  private async readAll(): Promise<TraeCredential[]> {
    const { credentials: desktop } = await this.readDesktopAll()
    // One entry per ACCOUNT, holding the FRESHEST copy: keeping the desktop copy
    // whenever both exist would silently discard every token this provider
    // refreshed (a refreshed credential is written to the vault, not the app).
    const byAccount = new Map<string, TraeCredential>()
    const consider = (credential: TraeCredential): void => {
      if (!this.matchesRegion(credential)) return
      const id = traeAccountId(credential)
      const incumbent = byAccount.get(id)
      if (incumbent === undefined || credential.expiresAtMs > incumbent.expiresAtMs) byAccount.set(id, credential)
    }
    for (const credential of desktop) consider(credential)
    for (const own of await this.persist.read()) consider(own)
    return [...byAccount.values()]
  }

  /** Which paths were tried and why each one failed; never token material. */
  async diagnose(): Promise<{ tried: TraeStorageCandidate[]; failures: TraeCandidateFailure[] }> {
    const tried = this.candidates()
    const failures: TraeCandidateFailure[] = []
    for (const candidate of tried) {
      const raw = await readFile(candidate.path, 'utf8').then(
        text => ({ text }),
        (error: unknown) => ({ error }),
      )
      if ('error' in raw) {
        const code = typeof raw.error === 'object' && raw.error !== null && 'code' in raw.error
          ? (raw.error as { code?: unknown }).code
          : undefined
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === 'ENOENT' ? 'missing' : 'unreadable',
          ...code === 'ENOENT' ? {} : { message: String(raw.error) },
        })
        continue
      }
      try {
        this.credentialFrom(candidate, raw.text)
      } catch (error: unknown) {
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: 'invalid',
          message: errorText(error),
        })
      }
    }
    return { tried, failures }
  }

  /** Parse one candidate file's text into a credential, or throw. */
  private credentialFrom(candidate: TraeStorageCandidate, text: string): TraeCredential {
    let credential: TraeCredential | undefined
    if (candidate.source === 'cli') {
      // A CLI token carries no host claim and no userRegion. Only the CN CLI
      // home is verified; an international CLI token is rejected rather than
      // silently misrouted to the CN gateway.
      if (regionOfEdition(candidate.edition) !== 'cn') {
        throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported`)
      }
      const claims = parseTraeCliToken(text)
      credential = normalizeTraeCredential({
        token: claims.accessToken,
        userId: claims.userId,
        host: CLI_DEFAULT_HOST,
        expiredAt: claims.expiresAtMs,
      }, candidate.edition, 'cli')
    } else {
      credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, 'desktop')
    }
    if (credential === undefined) throw new Error(`${candidate.source} candidate could not be normalized into a credential`)
    return credential
  }

  private async readDesktopAll(): Promise<{ credentials: TraeCredential[]; failures: TraeCandidateFailure[] }> {
    const credentials: TraeCredential[] = []
    const failures: TraeCandidateFailure[] = []
    for (const candidate of this.candidates()) {
      try {
        const credential = this.credentialFrom(candidate, await readFile(candidate.path, 'utf8'))
        if (!credentials.some(existing => traeAccountId(existing) === traeAccountId(credential))) credentials.push(credential)
      } catch (error: unknown) {
        // One stale or unsupported installation must not hide valid accounts.
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === 'ENOENT' ? 'missing' : code === undefined ? 'invalid' : 'unreadable',
          ...code === 'ENOENT' || (code === undefined && !(error instanceof Error)) ? {} : { message: errorText(error) },
        })
        continue
      }
    }
    return { credentials, failures }
  }

  private async refreshNow(credential: TraeCredential): Promise<TraeCredential> {
    if (credential.refreshToken === undefined
      || (credential.refreshExpiresAtMs !== undefined && credential.refreshExpiresAtMs <= Date.now())) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('Trae 访问令牌已过期且没有可用的刷新令牌，请在 Trae 桌面端重新登录')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: TraeCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresAtMs,
        ...outcome.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: outcome.refreshExpiresAtMs },
        ...outcome.host === undefined ? {} : { host: outcome.host },
        source: 'dsh',
      }
      // Read-modify-write, never overwrite: the vault holds every account of
      // the region, including imported ones that have no desktop file behind
      // them and could not be rediscovered.
      await this.persist.update(current => {
        const refreshedId = traeAccountId(refreshed)
        const entries = current.filter(item => traeAccountId(item) !== refreshedId)
        entries.push(refreshed)
        return entries
      })
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`Trae 令牌刷新失败，请重新登录（${errorText(error)}）`)
    }
  }
}
