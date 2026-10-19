/**
 * WorkBuddy credential resolution. The primary source is the WorkBuddy desktop
 * app's own auth file, read-only; the hub-owned refreshed copy lives in the
 * harness vault so the desktop file is never written. The effective credential
 * is whichever of the two expires later, unless the two disagree about the
 * account identity — then the desktop file wins, because it is the authority on
 * who is signed in now.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SecretSlot, Vault } from '../../core/vault.ts'
import {
  WorkBuddyAtRestKeyProvider,
  WorkBuddyElectronPathError,
  atRestKeyProviderFor,
  classifyDesktopAuthDocument,
  keyIdsOf,
  openAuthField,
  reasonCodeOf,
  unwrapDesktopAuthDocument,
} from './desktop-credential-protection.ts'
import type { DesktopAuthClassification, DesktopAuthFormat } from './desktop-credential-protection.ts'
import type { WorkBuddySignedOutReasonCode } from './reason-codes.ts'
import { CN_VARIANT, type WorkBuddyVariant } from './variants.ts'
import { regionOf } from './upstream.ts'
import type { WorkBuddyRefreshOutcome } from './upstream.ts'
import { isWsl } from './wsl.ts'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh'
}

/** The credential surface the transport and probe layers need. */
export interface WorkBuddyCredentialSource {
  current(): Promise<WorkBuddyCredential | undefined>
  resolve(): Promise<WorkBuddyCredential>
}

/** Read-only sign-in summary for status and diagnostics. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  source?: 'desktop' | 'dsh'
  /** Why no credential is usable, when diagnosable rather than "signed out". */
  reason?: string
  /** Machine-readable companion to {@link reason}. */
  reasonCode?: WorkBuddySignedOutReasonCode
}

/** The hub-owned vault payload: one refreshed credential plus its save time. */
export interface WorkBuddyOwnDocument {
  version: 1
  savedAtMs: number
  credential: WorkBuddyCredential
}

/** Constructor options; only {@link refresh} is required. */
export interface WorkBuddyStoreOptions {
  variant?: WorkBuddyVariant
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /** Vault holding this variant's hub-owned refreshed copy. */
  vault: Pick<Vault, 'read' | 'modify' | 'remove'>
  /** Vault slot for the hub-owned copy. */
  slot: SecretSlot
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
  /** Resolver for WorkBuddy 5.6's at-rest protector key; tests stand in a stub. */
  keyProvider?: Pick<WorkBuddyAtRestKeyProvider, 'protectorKeyFor' | 'helperPath'>
}

/** Env variable that overrides the CN desktop auth-file location. */
export const DSH_CONNECT_HUB_WORKBUDDY_AUTH_FILE_ENV = 'DSH_CONNECT_HUB_WORKBUDDY_AUTH_FILE'

/** Current on-disk format of the vault payload; other versions are ignored. */
const OWN_FORMAT_VERSION = 1

const DESKTOP_AUTH_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth'] as const

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
export function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE']) ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA']) ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA']) ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
    join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
  ]
}

/**
 * Platform-default candidates for the WorkBuddy desktop app's auth directory, in
 * probe order. Windows probes both AppData roots because builds differ; Linux
 * probes both XDG bases because UOS/deepin builds write under the data home.
 */
export function defaultDesktopAuthCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...DESKTOP_AUTH_RELATIVE_PATH)]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', ...DESKTOP_AUTH_RELATIVE_PATH),
      join(home, 'AppData', 'Roaming', ...DESKTOP_AUTH_RELATIVE_PATH),
    ]
  }
  if (process.platform === 'linux') {
    const configHome = xdgBase('XDG_CONFIG_HOME', join(home, '.config'))
    const dataHome = xdgBase('XDG_DATA_HOME', join(home, '.local', 'share'))
    const linux = dedupeCandidates([
      join(configHome, ...DESKTOP_AUTH_RELATIVE_PATH),
      join(dataHome, ...DESKTOP_AUTH_RELATIVE_PATH),
    ])
    return isWsl() ? dedupeCandidates([...wslDesktopAuthCandidates(home), ...linux]) : linux
  }
  return []
}

/** The XDG base directory for one env variable, or its platform default. */
function xdgBase(envName: string, fallback: string): string {
  const value = process.env[envName]?.trim()
  if (value !== undefined && value !== '' && value.startsWith('/')) return value
  return fallback
}

/** Drop duplicate candidates while keeping probe order. */
function dedupeCandidates(candidates: readonly string[]): string[] {
  return [...new Set(candidates)]
}

/** The platform-default candidates for one variant, in probe order. */
export function desktopAuthCandidatesFor(variant: WorkBuddyVariant): string[] {
  return dedupeCandidates(defaultDesktopAuthCandidates().map((dir) => join(dir, variant.desktopFilename)))
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the nested
 * `{"auth":{...},"account":{...}}` form and the flat panel form. Returns
 * undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity =
      typeof document['account'] === 'object' && document['account'] !== null
        ? (document['account'] as Record<string, unknown>)
        : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs =
    typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  return {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: 'desktop',
  }
}

/** Serialize the hub-owned vault payload. */
function ownDocument(credential: WorkBuddyCredential, savedAtMs: number): WorkBuddyOwnDocument {
  return { version: OWN_FORMAT_VERSION, savedAtMs, credential }
}

/** Parse the hub-owned vault payload; other versions and shapes are rejected. */
export function parseOwnDocument(value: unknown): WorkBuddyCredential | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const document = value as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  const stored = document['credential'] as Record<string, unknown>
  const accessToken = typeof stored['accessToken'] === 'string' ? stored['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs =
    typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
  const enterpriseId = optionalString(stored['enterpriseId'])
  const nickname = optionalString(stored['nickname'])
  return {
    accessToken,
    refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
    expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalString(stored['domain']) ?? '',
    uid: optionalString(stored['uid']) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: 'dsh',
  }
}

/**
 * The at-rest key provider a store uses when none is injected: it enables the
 * platform's app discovery, without which an encrypted desktop credential could
 * never be opened.
 */
export function createDefaultKeyProvider(
  variant: WorkBuddyVariant | undefined,
): WorkBuddyAtRestKeyProvider {
  return atRestKeyProviderFor(variant ?? CN_VARIANT)
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin (or
 * already expired), keep the refreshed credential in the vault, and never write
 * the desktop app's file. A failed refresh still returns a not-yet-expired token
 * so an unreachable refresh endpoint does not take down a working session.
 */
export class WorkBuddyCredentialStore {
  private readonly variant: WorkBuddyVariant | undefined
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly vault: WorkBuddyStoreOptions['vault']
  private readonly slot: SecretSlot
  private readonly keyProvider: NonNullable<WorkBuddyStoreOptions['keyProvider']>
  private desktopPathOverride: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: WorkBuddyStoreOptions) {
    this.variant = options.variant
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.vault = options.vault
    this.slot = options.slot
    this.keyProvider = options.keyProvider ?? createDefaultKeyProvider(options.variant)
    this.desktopPathOverride = options.desktopPath
  }

  /**
   * Configuration precedence for the desktop file: the explicit path, then the
   * environment variable, then the platform defaults (a probe order).
   */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[this.variant?.env ?? DSH_CONNECT_HUB_WORKBUDDY_AUTH_FILE_ENV]
    const explicit =
      this.desktopPathOverride ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return this.variant === undefined ? defaultDesktopAuthCandidates() : desktopAuthCandidatesFor(this.variant)
  }

  private resolveDesktopPath(): string | undefined {
    return this.resolveDesktopCandidates()[0]
  }

  /** Repoint the desktop file; a preference change applies on the next read. */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined {
    return this.resolveDesktopPath()
  }

  /** The vault slot holding the hub-owned copy, for diagnostics. */
  ownAuthPath(): string {
    return `vault:${this.slot}`
  }

  /** Read the freshest stored credential without refreshing anything. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    // A credential belonging to the other product is refused rather than used:
    // the two apps share one auth directory and differ only by filename, so a
    // misconfigured path or env var would leak one region's token to the other's
    // endpoint. Naming the file and the expected region makes it fixable.
    if (this.variant !== undefined) {
      for (const [label, credential] of [
        ['desktop file', desktop],
        ['hub credential copy', own],
      ] as const) {
        if (credential === undefined) continue
        const region = regionOf(credential.domain)
        if (region !== this.variant.region) {
          throw new WorkBuddyElectronPathError(
            'credential-region-mismatch',
            `${this.variant.displayName} received a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
              + ` in its ${label} (domain ${JSON.stringify(credential.domain)});`
              + ` point ${this.variant.env} at the ${this.variant.appName} sign-in, or remove the mismatched file`,
          )
        }
      }
    }
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    // Identity beats expiry: after the user switches accounts in the desktop
    // app, the hub copy still belongs to the previous account and may expire
    // later, so preferring it by expiry would answer as the wrong user.
    if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      const app = this.variant?.appName ?? 'WorkBuddy'
      throw new Error(
        `workbuddy: no signed-in ${app} account found; sign in once in the ${app} desktop app`
          + ` (expected ${desktop} or ${this.variant?.env ?? DSH_CONNECT_HUB_WORKBUDDY_AUTH_FILE_ENV}), or refresh an existing session`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<WorkBuddyAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out', reasonCode: 'no-credential' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...(credential.refreshExpiresAtMs === undefined
          ? {}
          : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
        ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
        ...(credential.domain === '' ? {} : { domain: credential.domain }),
        source: credential.source,
      }
    } catch (error: unknown) {
      const reasonCode = reasonCodeOf(error)
      return {
        state: 'signed-out',
        reason: error instanceof Error ? error.message : String(error),
        ...(reasonCode === undefined ? {} : { reasonCode }),
      }
    }
  }

  /** Remove the hub-owned copy; the desktop file is untouched. */
  async logout(): Promise<void> {
    await this.vault.remove(this.slot)
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        'workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app',
      )
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        expiresAtMs:
          outcome.expiresInSec !== undefined ? Date.now() + outcome.expiresInSec * 1000 : credential.expiresAtMs,
        ...(outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain }),
        source: 'dsh',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
          + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
  }

  /**
   * Persist the refreshed copy through the vault's exclusive read-modify-write,
   * so a concurrent writer cannot be silently overwritten.
   */
  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    await this.vault.modify<WorkBuddyOwnDocument>(this.slot, (current) => {
      const savedAtMs = typeof current?.savedAtMs === 'number' ? current.savedAtMs : Date.now()
      return ownDocument(credential, savedAtMs)
    })
  }

  /**
   * Read the first desktop candidate that exists. Only an absent file (ENOENT)
   * falls through to the next candidate; a present but unparsable file is
   * authoritative for its slot, so a stale older-version file never silently
   * wins over a broken newer one.
   *
   * Encrypted documents must be opened, never skipped; an unrecognized one
   * fails loudly. The desktop file, as long as it exists, is the identity
   * authority — a document this plugin cannot read must surface as a diagnosis
   * rather than be papered over by the hub-owned copy.
   */
  private async readDesktop(): Promise<WorkBuddyCredential | undefined> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        continue
      }
      const classification = classifyDesktopAuthDocument(text)
      if (classification.format === 'plaintext') return parseWorkBuddyAuth(text)
      if (classification.format === 'absent') continue
      if (classification.format === 'unrecognized') {
        throw new Error(
          `the desktop auth file at ${desktopPath} exists but is unreadable`
            + ' (neither a plaintext credential nor a decodable WorkBuddy 5.6 envelope);'
            + ' fix or remove the file — it outranks the hub credential copy',
        )
      }
      return await this.openEncryptedDesktop(classification)
    }
    return undefined
  }

  /** Open a 5.6 encrypted desktop document into the regular credential shape. */
  private async openEncryptedDesktop(
    classification: Extract<DesktopAuthClassification, { format: 'encrypted' }>,
  ): Promise<WorkBuddyCredential | undefined> {
    const wrapped = classification.wrapped
    const key = await this.keyProvider.protectorKeyFor(keyIdsOf(wrapped.fields))
    const text = unwrapDesktopAuthDocument(classification, (field) => {
      const plaintext = openAuthField(key, field.envelope)
      if (plaintext === undefined) {
        throw new WorkBuddyElectronPathError(
          'encrypted-credential-unreadable',
          `the encrypted desktop credential's ${field.field} could not be decrypted`
            + ` (envelope key id ${field.envelope.keyId});`
            + ' the WorkBuddy app may hold a different at-rest key — open it once to reseal the sign-in',
        )
      }
      return plaintext
    })
    return parseWorkBuddyAuth(text)
  }

  /** Classify the first desktop candidate that exists and carries content. */
  async desktopAuthFormat(): Promise<DesktopAuthFormat> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        continue
      }
      const format = classifyDesktopAuthDocument(text).format
      if (format !== 'absent') return format
    }
    return 'absent'
  }

  private async readOwn(): Promise<WorkBuddyCredential | undefined> {
    return parseOwnDocument(await this.vault.read<unknown>(this.slot))
  }

  /** The first desktop candidate the probe would actually read from. */
  async resolvedDesktopAuthPath(): Promise<string | undefined> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        continue
      }
      if (text.trim() === '') continue
      return desktopPath
    }
    return undefined
  }
}
