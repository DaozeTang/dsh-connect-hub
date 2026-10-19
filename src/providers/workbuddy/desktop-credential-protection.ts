
import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createDecipheriv, createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { WorkBuddySignedOutReasonCode } from './reason-codes.ts'
import { electronProfileFor } from './variants.ts'
import type { WorkBuddyElectronProduct, WorkBuddyVariant } from './variants.ts'
import { isWsl } from './wsl.ts'

/** The four states a desktop auth document can be read as. */
export type DesktopAuthFormat = 'absent' | 'plaintext' | 'encrypted' | 'unrecognized'

export const DSH_CONNECT_HUB_WORKBUDDY_ELECTRON_BIN_ENV = 'DSH_CONNECT_HUB_WORKBUDDY_ELECTRON_BIN'

/**
 * The platform-default Electron binary for one product, or `undefined` where
 * none is verified. macOS defaults come from each product's measured layout;
 * the Windows default needs `LOCALAPPDATA`, and the international app has no
 * verified default location at all — registry discovery only, never a guess.
 */
export function defaultWorkBuddyElectronPath(
  product: WorkBuddyElectronProduct,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'darwin') return product.macOS.defaultPath
  if (platform !== 'win32' || product.windows.defaultPathSegments === undefined) return undefined
  const localAppData = process.env.LOCALAPPDATA?.trim()
  return localAppData === undefined || localAppData === ''
    ? undefined
    : join(localAppData, ...product.windows.defaultPathSegments)
}

/** One decrypted-openable envelope's decoded parts. */
export interface WorkBuddyEnvelope {
  suite: number
  keyId: string
  nonce: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

/** One auth field found in its encrypted wrapper, with its envelope decoded. */
export interface WrappedAuthField {
  field: 'accessToken' | 'refreshToken'
  envelope: WorkBuddyEnvelope
}

/**
 * A read desktop auth document, as a discriminated union on `format`. The
 * `encrypted` variant carries the parsed document plus the fields still in
 * wrappers; the caller decrypts those fields and hands the rebuilt text to
 * the regular parser, so identity and expiry fields need no second code path.
 */
export type DesktopAuthClassification =
  | { format: 'absent' }
  | { format: 'plaintext' }
  | { format: 'encrypted', wrapped: { document: Record<string, unknown>, fields: readonly WrappedAuthField[] } }
  | { format: 'unrecognized' }

/** Distinct key ids across the wrapped fields, in field order. */
export function keyIdsOf(fields: readonly WrappedAuthField[]): string[] {
  return [...new Set(fields.map(wrapped => wrapped.envelope.keyId))]
}

/**
 * Whether a raw value is the 5.6 field wrapper, with its inner envelope
 * decodable. The wrapper is `{$wbEncrypted:1, envelope:<base64 of a JSON
 * {suite,keyId,nonce,authTag,ciphertext>}}`; anything claiming the flag whose
 * envelope cannot be decoded makes the whole document unrecognized rather
 * than encrypted, because no key could ever open it.
 */
function parseWrappedField(field: 'accessToken' | 'refreshToken', value: unknown): WrappedAuthField | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wrapped = value as Record<string, unknown>
  if (wrapped['$wbEncrypted'] !== 1 || typeof wrapped['envelope'] !== 'string') return undefined
  let inner: unknown
  try {
    inner = JSON.parse(Buffer.from(wrapped['envelope'], 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined
  const parts = inner as Record<string, unknown>
  const nonce = parseBase64(parts['nonce'], 12)
  const authTag = parseBase64(parts['authTag'], 16)
  const ciphertext = parseBase64(parts['ciphertext'])
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (typeof parts['suite'] !== 'number' || !Number.isInteger(parts['suite'])) return undefined
  // Suite 1 is the only scheme WorkBuddy 5.6.x defines for credential fields.
  // Anything else is a format this plugin has not seen, so the wrapper is not
  // claimed as encrypted — the document then reads as unrecognized and the
  // store reports a diagnosis instead of attempting a blind open.
  if (parts['suite'] !== 1) return undefined
  if (typeof parts['keyId'] !== 'string' || !/^[0-9a-f]{16}$/u.test(parts['keyId'])) return undefined
  return {
    field,
    envelope: {
      suite: parts['suite'],
      keyId: parts['keyId'],
      nonce,
      authTag,
      ciphertext,
    },
  }
}

/** Decode a base64 value and check its exact byte length when given. */
function parseBase64(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
  // Buffer.from is lenient about stray characters; require the round-trip so a
  // tampered envelope is rejected before any key material is involved.
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined
  return length === undefined || decoded.length === length ? decoded : undefined
}

const AUTH_FIELDS = ['accessToken', 'refreshToken'] as const

/**
 * Read a desktop auth document's format. `absent` is an empty file; `plaintext`
 * is any document the regular parser could read (even one without a token);
 * `encrypted` has at least one field in a decodable wrapper; everything else —
 * unparsable JSON, non-objects, wrappers whose envelope will not decode — is
 * `unrecognized`.
 */
export function classifyDesktopAuthDocument(text: string): DesktopAuthClassification {
  if (text.trim() === '') return { format: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { format: 'unrecognized' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { format: 'unrecognized' }
  const document = parsed as Record<string, unknown>
  const auth = typeof document['auth'] === 'object' && document['auth'] !== null
    ? document['auth'] as Record<string, unknown>
    : document
  const fields: WrappedAuthField[] = []
  for (const field of AUTH_FIELDS) {
    const value = auth[field]
    if (typeof value === 'string') continue
    const wrapped = parseWrappedField(field, value)
    // A field in *some* object that is not a decodable wrapper: not plaintext,
    // not usable. Treated as unrecognized below unless another field wrapped.
    if (wrapped === undefined && value !== undefined) return { format: 'unrecognized' }
    if (wrapped !== undefined) fields.push(wrapped)
  }
  if (fields.length === 0) return { format: 'plaintext' }
  return { format: 'encrypted', wrapped: { document, fields } }
}

/**
 * Decrypt a wrapped document into the plaintext text the regular parser reads.
 * Throws a diagnosable error naming the field and key ids — never envelope or
 * token content — when any wrapped field cannot be opened.
 */
export function unwrapDesktopAuthDocument(
  classification: Extract<DesktopAuthClassification, { format: 'encrypted' }>,
  openField: (wrapped: WrappedAuthField) => string,
): string {
  const wrapped = classification.wrapped
  const rebuilt = structuredClone(wrapped.document) as Record<string, unknown>
  const auth = typeof rebuilt['auth'] === 'object' && rebuilt['auth'] !== null
    ? rebuilt['auth'] as Record<string, unknown>
    : rebuilt
  for (const field of wrapped.fields) {
    auth[field.field] = openField(field)
  }
  return JSON.stringify(rebuilt)
}

export function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  // No sequence numbers on credential fields; the trailing zero byte is the
  // default context the desktop app writes.
  return Buffer.concat([
    prefix, Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/**
 * Open one envelope with a protector key; `undefined` when it will not open.
 * The accepted format is exactly what WorkBuddy 5.6.2 writes — suite 1 under
 * the `field` framing — so a failure means "not this format / wrong key",
 * and is reported as such rather than retried against other framings.
 */
export function openAuthField(key: Buffer, envelope: WorkBuddyEnvelope): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/** The validated `loggerGet()` payload: the sealed at-rest secret. */
export interface WorkBuddyAtRestPayload {
  atRestSecretKey: string
}

/**
 * Validate the helper's payload against the app's own rules: `version:1` and
 * a canonical-base64 32-byte, non-all-zero secret. `undefined` otherwise.
 */
export function parseAtRestPayload(text: string): WorkBuddyAtRestPayload | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const payload = parsed as Record<string, unknown>
  if (payload['version'] !== 1) return undefined
  const secret = payload['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') return undefined
  let decoded: Buffer
  try {
    decoded = Buffer.from(secret, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length !== 32) return undefined
  if (decoded.toString('base64') !== secret) return undefined
  if (decoded.every(byte => byte === 0)) return undefined
  return { atRestSecretKey: secret }
}

/** Derive the protector key from the payload's secret (sha256 over its UTF-8 string). */
export function deriveProtectorKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** A resolved protector key and the id envelopes name for it. */
interface ResolvedKey {
  key: Buffer
  keyId: string
}

/** The spawned helper. Separated from the provider so tests can stand it in. */
export type WorkBuddyKeyPayloadSource = () => Promise<string>

/**
 * Which automatic discovery, if any, this provider may run when no explicit
 * binary is configured.
 *
 * The value says which *platform* may be searched, never which product: two
 * products on the same platform are told apart by the product profile
 * ({@link WorkBuddyElectronProduct} — bundle id, registry name, exe basename),
 * so a search for one can never execute the other's binary. `none` remains the
 * safe default for platforms without a verified layout (Linux today).
 */
export type WorkBuddyElectronDiscovery = 'none' | 'macos-workbuddy' | 'windows-workbuddy'

/**
 * Select discovery by platform. Both products have verified layouts on macOS
 * and Windows (the international app is registry-only there), so discovery no
 * longer gates on region; Linux and others stay `none`.
 */
export function electronDiscoveryFor(
  platform: NodeJS.Platform = process.platform,
): WorkBuddyElectronDiscovery {
  if (platform === 'darwin') return 'macos-workbuddy'
  if (platform === 'win32') return 'windows-workbuddy'
  return 'none'
}

/**
 * The at-rest key provider one variant's store should use. Shared by every
 * caller so the browser card and any host-side check can never disagree about
 * which binary a variant resolves.
 */
export function atRestKeyProviderFor(variant: Pick<WorkBuddyVariant, 'id' | 'electron'>): WorkBuddyAtRestKeyProvider {
  return new WorkBuddyAtRestKeyProvider({
    product: electronProfileFor(variant),
    discovery: electronDiscoveryFor(),
  })
}

/** Absolute tool paths: never resolved through PATH, which a user can change. */
const MDFIND_BIN = '/usr/bin/mdfind'
const PLUTIL_BIN = '/usr/bin/plutil'
const WINDOWS_REGISTRY_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const
const WINDOWS_REGISTRY_OUTPUT_MAX_BYTES = 1024 * 1024
const WINDOWS_ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

const WINDOWS_REGISTRY_RELATIVE_POWERSHELL = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/** Exit code meaning the root key does not exist (a normal, expected outcome). */
const WINDOWS_POWERSHELL_ROOT_ABSENT = 2
/** Exit code meaning the root exists but a part of it could not be read. */
const WINDOWS_POWERSHELL_ROOT_UNREADABLE = 3
const WINDOWS_POWERSHELL_QUERY_SCRIPT = [
  'param([string]$Root)',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
  '$ErrorActionPreference="Stop";',
  '$path="Registry::"+$Root;',
  'if (-not (Test-Path -LiteralPath $path)) { [Console]::Error.Write("root absent"); exit 2 };',
  'try { $k=Get-Item -LiteralPath $path -ErrorAction Stop } catch { [Console]::Error.Write("root unreadable"); exit 3 };',
  '$out=@();',
  'foreach ($n in $k.GetSubKeyNames()) {',
  '  try { $p=$k.OpenSubKey($n); if ($null -eq $p) { throw "null" } } catch { [Console]::Error.Write("subkey unreadable"); exit 3 };',
  '  $d=$p.GetValue("DisplayName");$i=$p.GetValue("DisplayIcon");',
  '  if ($null -ne $d -or $null -ne $i) { $out += [pscustomobject]@{ displayName=[string]$d; displayIcon=[string]$i } }',
  '};',
  'ConvertTo-Json -InputObject @($out) -Compress -Depth 3',
].join(' ')

export const WINDOWS_POWERSHELL_QUERY_COMMAND = `& { ${WINDOWS_POWERSHELL_QUERY_SCRIPT} }`

/**
 * The only roots this tool will name on a `-Command` command line.
 *
 * `powershell.exe` re-parses everything after `-Command` as code, so a root
 * is handed over only when it is provably inert in that position: a hive
 * this file actually queries, then subkey components of plain path
 * characters — no spaces, quotes, subexpressions, or any other byte that
 * could change what the joined command does. Production roots are the fixed
 * {@link WINDOWS_REGISTRY_ROOTS}; anything else is refused before any
 * process starts, as "we could not check", never as executable text.
 */
const WINDOWS_REGISTRY_ROOT_PATTERN = /^HK(?:LM|CU)(?:\\[A-Za-z0-9._-]+)+$/u

/**
 * One discovery subprocess's own limits; see {@link WorkBuddyAtRestKeyProviderOptions}.
 *
 * Governs the macOS discovery tools (Spotlight, plutil). The Windows registry
 * readers have their own, larger limit — {@link WINDOWS_REGISTRY_STEP_TIMEOUT_MS}.
 */
export const WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS = 3_000
/** Whole-discovery budget, independent of the helper's own timeout. */
export const WORKBUDDY_DISCOVERY_BUDGET_MS = 10_000
export const WINDOWS_REGISTRY_STEP_TIMEOUT_MS = 10_000
const MDFIND_MAX_OUTPUT_BYTES = 1024 * 1024
const PLUTIL_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Why a discovery step could not produce an answer. Every one of these means
 * "we do not know", explicitly *not* "the candidate does not exist" — the
 * distinction is what keeps a half-finished check from being mistaken for a
 * unique candidate.
 */
class DiscoveryIncompleteError extends Error {}

/** A discovered app: its `.app` bundle and the Electron binary inside it. */
interface DiscoveredApp {
  bundlePath: string
  electronPath: string
  /** Display version, best effort; absent when unreadable. */
  version?: string
}

/** Seams the discovery flow runs through, so tests never spawn a process. */
export interface WorkBuddyDiscoveryTools {
  /** Candidate `.app` bundles for the product's bundle id, or a throw for an unusable tool. */
  findApps: (signal: AbortSignal) => Promise<readonly string[]>
  /**
   * `CFBundleIdentifier` of a bundle, or `undefined` when the tool could not
   * read it — which is "we could not check this candidate", never "it does not
   * match". A successful read of a *different* id returns that id, and the
   * caller excludes the candidate.
   */
  bundleIdentifier: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
  /** Display version, best effort; `undefined` when unavailable. */
  bundleVersion: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
}

/** Windows-only seam for querying one uninstall registry root. */
export interface WorkBuddyWindowsDiscoveryTools {
  queryUninstallRoot: (root: string, signal: AbortSignal) => Promise<string>
}

/** Provider options. */
export interface WorkBuddyAtRestKeyProviderOptions {
  /**
   * Which product's Electron this provider resolves. Required and the only
   * source of product identity: it names the explicit-path env var, the bundle
   * id / registry name / exe basename discovery must match, and the platform
   * default. Without it the provider could not even decide which env var to
   * read — the discovery setting alone cannot carry this (both products are
   * `none` on Linux, yet each must read its own variable).
   */
  product: WorkBuddyElectronProduct
  /** Explicit Electron binary; overrides the platform default and env. */
  electronPath?: string
  /** Helper timeout in milliseconds; default 10s. */
  timeoutMs?: number
  /**
   * Where the payload comes from. Defaults to spawning WorkBuddy's own
   * Electron with `ELECTRON_RUN_AS_NODE=1`; tests supply a stand-in so no
   * test ever touches the real binary or a real key. Supplying this replaces
   * path *resolution* too, so tests about resolution use
   * {@link spawnHelper} instead.
   */
  source?: WorkBuddyKeyPayloadSource
  /**
   * Runs the helper at the resolved path. Distinct from {@link source}, which
   * replaces the whole payload path: this seam keeps resolution — explicit
   * config, platform default, discovery — real, so tests can exercise it
   * without spawning anything.
   */
  spawnHelper?: (electronPath: string) => Promise<string>
  /**
   * Automatic discovery budget; defaults to `'none'` (see
   * {@link WorkBuddyElectronDiscovery}). Passed explicitly per variant at the
   * composition root, never inferred from the environment.
   */
  discovery?: WorkBuddyElectronDiscovery
  /**
   * Platform default binary, consulted only when `discovery` is enabled and no
   * explicit path is configured. Injectable so tests can force the fallback
   * branch without moving the real app; `null` means "no default here".
   */
  defaultElectronPath?: string | undefined
  /** Discovery subprocesses; injectable so tests never spawn. */
  tools?: WorkBuddyDiscoveryTools
  /** Windows registry discovery subprocess; injectable so tests never spawn. */
  windowsTools?: WorkBuddyWindowsDiscoveryTools
  /** Platform override for deterministic discovery tests. */
  platform?: NodeJS.Platform
  wsl?: () => boolean
  /**
   * Total budget for one discovery run, covering the search and every
   * candidate check. Injectable so tests can exercise exhaustion without
   * waiting out the production 10s.
   */
  discoveryBudgetMs?: number
}

export function wslenvForwardRunAsNode(value: string | undefined): string {
  const merged: string[] = []
  /** Index of the consolidated target entry inside `merged`, once placed. */
  let targetIndex = -1
  /** The safe flag set for the target: always `w`, plus `u` if asked for. */
  let targetFlags = '/w'
  for (const entry of (value ?? '').split(':')) {
    if (entry === '') continue
    const slash = entry.indexOf('/')
    const name = slash === -1 ? entry : entry.slice(0, slash)
    if (name !== 'ELECTRON_RUN_AS_NODE') {
      // Other variables are none of the plugin's business: keep them as-is,
      // collapsing only exact duplicates.
      if (!merged.includes(entry)) merged.push(entry)
      continue
    }
    const flags = slash === -1 ? '' : entry.slice(slash + 1)
    // A later duplicate may be the one carrying the `u` direction; remember
    // it and re-write the single consolidated entry in place.
    if (flags.includes('u')) targetFlags = '/uw'
    if (targetIndex === -1) {
      targetIndex = merged.length
      merged.push(`ELECTRON_RUN_AS_NODE${targetFlags}`)
    } else {
      merged[targetIndex] = `ELECTRON_RUN_AS_NODE${targetFlags}`
    }
  }
  if (targetIndex === -1) merged.push(`ELECTRON_RUN_AS_NODE${targetFlags}`)
  return merged.join(':')
}

/**
 * Environment variables the credential helper may inherit.
 *
 * The helper is the WorkBuddy app's own Electron binary run as plain Node; it
 * needs only process basics (a home/temp directory, locale, PATH) to start, and
 * receives nothing else from the parent. Every other variable — tokens, API
 * keys, CI credentials — stays in the plugin process.
 */
const HELPER_ENV_ALLOWLIST: ReadonlySet<string> = new Set(
  [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SystemRoot',
    'WINDIR',
    'WSLENV',
  ].map((name) => name.toUpperCase()),
)

/**
 * The minimal environment the at-rest key helper is spawned with.
 *
 * Always a fresh object: the parent (`process.env` in production) is neither
 * mutated nor handed over wholesale. `ELECTRON_RUN_AS_NODE=1` forces the
 * Electron binary into plain Node mode; when the spawn crosses WSL→Windows
 * interop — a WSL host and a helper that is itself a Windows executable — the
 * child's `WSLENV` is additionally merged via {@link wslenvForwardRunAsNode} so
 * the interop layer actually forwards that variable.
 *
 * @param parent - the environment to allow-list from (never modified).
 * @param electronPath - the helper binary about to be spawned.
 * @param wsl - whether the current process runs inside WSL.
 * @returns the minimized child process environment.
 */
export function helperChildEnv(parent: NodeJS.ProcessEnv, electronPath: string, wsl: boolean): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {}
  // Copying the parent's own spelling keeps Windows' case-insensitive names
  // (e.g. `SystemRoot`) exactly as the platform set them.
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && HELPER_ENV_ALLOWLIST.has(name.toUpperCase())) childEnv[name] = value
  }
  childEnv['ELECTRON_RUN_AS_NODE'] = '1'
  // The interop decision follows the FILE, not the mount point: WSL's
  // automount root is configurable (`/windir/`, `/`, …), so a Windows exe can
  // legitimately live outside `/mnt`. A Windows executable is recognized by
  // its `.exe` suffix (case-insensitive); a native Linux helper — even one
  // installed under `/mnt` — never consults WSLENV and stays untouched.
  if (wsl && basename(electronPath).toLowerCase().endsWith('.exe')) {
    childEnv['WSLENV'] = wslenvForwardRunAsNode(childEnv['WSLENV'])
  }
  return childEnv
}

/**
 * The default discovery tools: Spotlight for the bundle, `/usr/bin/plutil` for
 * identity. Every failure that means "we could not tell" — a missing tool, a
 * timeout, an oversized answer — is raised as {@link DiscoveryIncompleteError}
 * so it can never be silently read as "no such app".
 *
 * `bundleId` is the product being searched for; the Spotlight query and the
 * caller's identity comparison both use it, so the two can never disagree
 * about which app they are looking for.
 */
export function workBuddyDiscoveryTools(bundleId: string): WorkBuddyDiscoveryTools {
  const runTool = (bin: string, args: readonly string[], maxBytes: number, signal: AbortSignal): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DiscoveryIncompleteError(`${bin} was not started: the discovery budget was already spent`))
        return
      }
      let settled = false
      const child = execFile(bin, [...args], { maxBuffer: maxBytes, timeout: WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS }, (error, stdout) => {
        if (settled) return
        settled = true
        if (error !== null && error !== undefined) {
          reject(new DiscoveryIncompleteError(`${bin} could not complete (${error.killed === true ? 'timed out' : String(error.code ?? 'unavailable')})`))
          return
        }
        resolve(stdout)
      })
      const abort = (): void => {
        if (settled) return
        settled = true
        child.kill()
        reject(new DiscoveryIncompleteError(`${bin} was abandoned: the discovery budget was spent`))
      }
      signal.addEventListener('abort', abort, { once: true })
      child.on('close', () => { signal.removeEventListener('abort', abort) })
    })

  return {
    findApps: async signal => {
      const out = await runTool(
        MDFIND_BIN,
        [`kMDItemCFBundleIdentifier == '${bundleId}'`],
        MDFIND_MAX_OUTPUT_BYTES,
        signal,
      )
      return out.split('\n').map(line => line.trim()).filter(line => line.endsWith('.app'))
    },
    bundleIdentifier: async (bundlePath, signal) => {
      try {
        const out = await runTool(
          PLUTIL_BIN,
          ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')],
          PLUTIL_MAX_OUTPUT_BYTES,
          signal,
        )
        return out.trim()
      } catch {
        // An unreadable plist is "we could not check this one", not "this one
        // does not match" — the candidate stays unresolved and the whole
        // discovery reports incomplete rather than quietly dropping it.
        return undefined
      }
    },
    bundleVersion: async (bundlePath, signal) => {
      try {
        const out = await runTool(
          PLUTIL_BIN,
          ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')],
          PLUTIL_MAX_OUTPUT_BYTES,
          signal,
        )
        const version = out.trim()
        return version === '' ? undefined : version
      } catch {
        return undefined
      }
    },
  }
}

/**
 * The Windows registry discovery tool. It is deliberately separate from the
 * macOS Spotlight/plutil seam: the two platforms have different identity and
 * candidate rules, and neither tool should accidentally become cross-platform.
 */
export function workBuddyWindowsDiscoveryTools(): WorkBuddyWindowsDiscoveryTools {
  const systemRoot = process.env.SystemRoot?.trim()
  const regPath = systemRoot === undefined || systemRoot === ''
    ? undefined
    : join(systemRoot, 'System32', 'reg.exe')
  /**
   * The fallback interpreter. Resolved by absolute path from SystemRoot, like
   * `reg.exe`: never through PATH, which a user can change.
   *
   * Windows PowerShell 5.1 ships with Windows, so unlike `pwsh` it can be
   * relied on; the script is written to its syntax (see
   * {@link WINDOWS_POWERSHELL_QUERY_SCRIPT}).
   */
  const powershellPath = systemRoot === undefined || systemRoot === ''
    ? undefined
    : join(systemRoot, WINDOWS_REGISTRY_RELATIVE_POWERSHELL)
  const runTool = (root: string, signal: AbortSignal): Promise<Buffer> => new Promise<Buffer>((resolve, reject) => {
    if (regPath === undefined) {
      reject(new DiscoveryIncompleteError('SystemRoot is not configured'))
      return
    }
    if (signal.aborted) {
      reject(new DiscoveryIncompleteError('reg.exe was not started: the discovery budget was already spent'))
      return
    }
    let settled = false
    const child = execFile(regPath, ['query', root, '/s'], {
      maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
      timeout: WINDOWS_REGISTRY_STEP_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (settled) return
      settled = true
      // `reg query` uses exit code 1 for more than a missing key. Only a
      // confirmed missing-key diagnostic is an empty result; every other
      // failure stays incomplete rather than becoming "not installed".
      //
      // Both supported diagnostics are ASCII in every code page, so reading
      // stderr as UTF-8 cannot change whether this regex matches; a diagnostic
      // that is not one of them stays incomplete, as before.
      if (error !== null && error !== undefined) {
        if (error.killed !== true && (error.code === 1 || error.code === '1')
          && windowsRegistryKeyMissingFromBytes(stderr)) {
          resolve(Buffer.alloc(0))
          return
        }
        reject(new DiscoveryIncompleteError(`reg.exe could not complete (${subprocessFailureReason(error)})`))
        return
      }
      resolve(stdout)
    })
    const abort = (): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(new DiscoveryIncompleteError('reg.exe was abandoned: the discovery budget was spent'))
    }
    signal.addEventListener('abort', abort, { once: true })
    child.on('close', () => { signal.removeEventListener('abort', abort) })
  })

  const runFallback = (root: string, signal: AbortSignal): Promise<string> => new Promise<string>((resolve, reject) => {
    // Guarded before anything starts: this root is about to ride a command
    // line that is re-parsed as code, so it must be a plain path (see
    // WINDOWS_REGISTRY_ROOT_PATTERN).
    if (!WINDOWS_REGISTRY_ROOT_PATTERN.test(root)) {
      reject(new DiscoveryIncompleteError('the registry root was not a plain HKLM/HKCU path this tool may query'))
      return
    }
    if (powershellPath === undefined) {
      reject(new DiscoveryIncompleteError('SystemRoot is not configured'))
      return
    }
    if (signal.aborted) {
      reject(new DiscoveryIncompleteError('powershell.exe was not started: the discovery budget was already spent'))
      return
    }
    let settled = false
    const child = execFile(powershellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_POWERSHELL_QUERY_COMMAND,
      '-Root',
      root,
    ], {
      maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
      timeout: WINDOWS_REGISTRY_STEP_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (settled) return
      settled = true
      if (error !== null && error !== undefined) {
        // Classification is by exit code, never by stderr text: these
        // diagnostics are written by PowerShell and may themselves be
        // unreadable in a non-UTF-8 console.
        const code = error.killed === true ? undefined : Number(error.code)
        if (code === WINDOWS_POWERSHELL_ROOT_ABSENT) {
          resolve('')
          return
        }
        if (code === WINDOWS_POWERSHELL_ROOT_UNREADABLE) {
          reject(new DiscoveryIncompleteError(`powershell.exe could not read the registry root ${root}`))
          return
        }
        reject(new DiscoveryIncompleteError(`powershell.exe could not complete (${subprocessFailureReason(error)})`))
        return
      }
      const records = parseWindowsUninstallJson(stdout)
      if (records === undefined) {
        reject(new DiscoveryIncompleteError('powershell.exe output was not the expected registry document'))
        return
      }
      resolve(records)
    })
    const abort = (): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(new DiscoveryIncompleteError('powershell.exe was abandoned: the discovery budget was spent'))
    }
    signal.addEventListener('abort', abort, { once: true })
    child.on('close', () => { signal.removeEventListener('abort', abort) })
  })

  return {
    queryUninstallRoot: async (root, signal) => {
      const raw = await runTool(root, signal)
      if (isAsciiOnly(raw)) return raw.toString('utf8')
      return await runFallback(root, signal)
    },
  }
}

/**
 * Whether every byte is ASCII, the one case where a decode cannot be wrong.
 *
 * @param bytes - the child's raw stdout.
 */
function isAsciiOnly(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte >= 0x80) return false
  }
  return true
}

/**
 * Turn the fallback's JSON into the same column-shaped document
 * {@link parseWindowsRegistryOutput} already consumes.
 *
 * Re-encoding into the `reg query` text form on purpose: the parser and
 * {@link parseWindowsDisplayIcon} carry the candidate-quoting rules that are
 * shared with existing tests, and the seam between this tool and the provider
 * is a string. Records carrying neither value are skipped, and the key name is
 * synthetic because only the values are read.
 *
 * @param output - the child's UTF-8 stdout.
 * @returns the document, or `undefined` when it was not the expected JSON.
 */
function parseWindowsUninstallJson(output: string): string | undefined {
  let document: unknown
  try {
    document = JSON.parse(output)
  } catch {
    return undefined
  }
  // `ConvertTo-Json` collapses a one-element array into a bare object.
  const rows = Array.isArray(document) ? document : [document]
  const lines: string[] = []
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    const displayName = record['displayName']
    const displayIcon = record['displayIcon']
    if (typeof displayName !== 'string' && typeof displayIcon !== 'string') continue
    lines.push(`HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{PS-${String(index)}}`)
    if (typeof displayName === 'string') lines.push(`    DisplayName    REG_SZ    ${displayName}`)
    if (typeof displayIcon === 'string') lines.push(`    DisplayIcon    REG_SZ    ${displayIcon}`)
  }
  return lines.join('\r\n')
}

/**
 * In-memory protector-key resolver: one spawn per key id, single-flight, never
 * persisted. The cache is keyed by the id envelopes ask for, so an envelope
 * sealed under a rotated key triggers exactly one fresh resolution.
 */export class WorkBuddyAtRestKeyProvider {
  /**
   * The explicit binary, when one was configured. `undefined` here means "the
   * caller did not name one", which is what lets discovery run — an explicit
   * path that turns out to be unusable is an error, never a reason to look for
   * a different app.
   */
  private readonly explicitPath: string | undefined
  private readonly product: WorkBuddyElectronProduct
  private readonly defaultPath: string | undefined
  private readonly discovery: WorkBuddyElectronDiscovery
  private readonly tools: WorkBuddyDiscoveryTools
  private readonly windowsTools: WorkBuddyWindowsDiscoveryTools
  private readonly platform: NodeJS.Platform
  private readonly discoveryBudgetMs: number
  private readonly timeoutMs: number
  private readonly wsl: () => boolean
  private readonly source: WorkBuddyKeyPayloadSource
  private readonly spawnHelper: (electronPath: string) => Promise<string>
  /**
   * The path discovery settled on, cached only on success. A failure leaves
   * this unset so the next attempt tries again — the user may install or move
   * the app without restarting DSH.
   */
  private discoveredPath: string | undefined
  private cache: ResolvedKey | undefined
  private inflight: Promise<ResolvedKey> | undefined

  constructor(options: WorkBuddyAtRestKeyProviderOptions) {
    this.product = options.product
    const fromEnv = process.env[options.product.envVar]?.trim()
    const envPath = fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
    // Explicit sources are authoritative and mutually exclusive with
    // discovery: naming a binary means "use this one", so an unusable one is
    // an error, not an invitation to go looking for another app.
    this.explicitPath = options.electronPath ?? envPath
    this.discovery = options.discovery ?? 'none'
    this.platform = options.platform ?? process.platform
    this.defaultPath = this.discovery === 'none'
      ? undefined
      : options.defaultElectronPath === undefined
        ? defaultWorkBuddyElectronPath(options.product, this.platform)
        : options.defaultElectronPath ?? undefined
    this.tools = options.tools ?? workBuddyDiscoveryTools(options.product.macOS.bundleId)
    this.windowsTools = options.windowsTools ?? workBuddyWindowsDiscoveryTools()
    this.discoveryBudgetMs = options.discoveryBudgetMs ?? WORKBUDDY_DISCOVERY_BUDGET_MS
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.wsl = options.wsl ?? isWsl
    this.spawnHelper = options.spawnHelper ?? (path => this.spawnAt(path))
    this.source = options.source ?? (() => this.spawnPayload())
  }

  /**
   * The binary the default helper would use, for diagnostics.
   *
   * Reports a *discovery result* once one exists, so diagnostics describe what
   * would actually run rather than the default that was bypassed. Discovery
   * itself stays in {@link resolveElectronPath}: this accessor never triggers a
   * search (the constructor must remain I/O-free, and callers may ask before
   * any resolution has happened).
   */
  helperPath(): string | undefined {
    if (this.explicitPath !== undefined) return this.explicitPath
    if (this.discovery === 'none') return undefined
    return this.discoveredPath ?? this.defaultPath
  }

  /**
   * A protector key matching one of the requested envelope key ids. The first
   * id the cache answers wins; otherwise one spawn resolves the current key,
   * which must match a request — a mismatch means the envelopes were sealed by
   * a different install than the one this machine now runs, and no key we can
   * reach will open them.
   */
  async protectorKeyFor(requested: readonly string[]): Promise<Buffer> {
    if (requested.length === 0) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'encrypted desktop credential carries no key ids',
      )
    }
    const cached = this.cache
    if (cached !== undefined && requested.includes(cached.keyId)) return cached.key
    this.inflight ??= this.source().then(text => this.ingest(text))
      .finally(() => {
        this.inflight = undefined
      })
    const resolved = await this.inflight
    if (!requested.includes(resolved.keyId)) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        `WorkBuddy's current at-rest key (id ${resolved.keyId}) does not match the credential's envelope (id ${requested.join(' or ')});`
        + ' the desktop credential was sealed by a different WorkBuddy installation',
      )
    }
    return resolved.key
  }

  private ingest(text: string): ResolvedKey {
    const payload = parseAtRestPayload(text)
    if (payload === undefined) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'WorkBuddy key helper returned an unusable at-rest payload (expected {version:1, atRestSecretKey})',
      )
    }
    const key = deriveProtectorKey(payload.atRestSecretKey)
    const resolved: ResolvedKey = {
      key,
      keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
    }
    this.cache = resolved
    return resolved
  }

  /**
   * The binary to spawn, or a diagnosable error saying why there is none.
   *
   * Order is the contract: an explicit path is used as-is and never falls back;
   * discovery runs only for a provider that was configured for it, and only
   * after the platform default has been tried and found unusable.
   */
  // Residual risk: the candidate is located by bundle id / install path and
  // then executed to unlock the encrypted sign-in; there is no code-signature
  // check, so only install WorkBuddy from a trusted source.
  private async resolveElectronPath(): Promise<string> {
    if (this.explicitPath !== undefined) {
      if (!isExecutable(this.explicitPath)) {
        throw new WorkBuddyElectronPathError(
          'electron-path-invalid',
          `the configured ${this.product.productName} Electron binary is not available at ${this.explicitPath};`
          + ` check ${this.product.envVar} or unset it to let the plugin look for the app itself`,
        )
      }
      return this.explicitPath
    }
    if (this.discovery === 'none') {
      // A platform without a verified layout: "not configured", never "we
      // searched and failed".
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no ${this.product.productName} Electron binary is configured for this platform;`
        + ` set ${this.product.envVar} to the app's Electron binary`,
      )
    }
    // The default path is the ordinary case and costs one stat; discovery is
    // reserved for the installations the default misses.
    if (this.defaultPath !== undefined && isExecutable(this.defaultPath)) return this.defaultPath
    // A previously discovered path is re-checked rather than trusted: the app
    // may have been moved or removed since, and a stale path must not win.
    if (this.discoveredPath !== undefined) {
      if (isExecutable(this.discoveredPath)) return this.discoveredPath
      this.discoveredPath = undefined
    }
    const found = this.discovery === 'macos-workbuddy'
      ? await this.discoverMacosApp()
      : await this.discoverWindowsApp()
    this.discoveredPath = found
    return found
  }

  /**
   * Resolve this product's app through Spotlight, then prove each candidate's
   * identity before it can be executed.
   *
   * The whole flow shares one budget: a hang in one candidate must not extend
   * the wait for the others, and running out of budget is reported as an
   * unfinished check rather than an absent app.
   */
  private async discoverMacosApp(): Promise<string> {
    if (this.platform !== 'darwin') {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no ${this.product.productName} Electron binary is configured for this platform;`
        + ` set ${this.product.envVar} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs)
    try {
      let candidates: readonly string[]
      try {
        candidates = await this.tools.findApps(controller.signal)
      } catch {
        throw discoveryIncomplete(this.product.productName, 'the app search did not complete')
      }
      // Several Spotlight rows can name one bundle (path aliases, the
      // /System/Volumes/Data view). Identity + realpath collapse those into
      // one candidate; only genuinely distinct apps may count as "more than
      // one", or a single app would look ambiguous.
      const seen = new Map<string, DiscoveredApp>()
      let unresolved = false
      for (const candidate of candidates) {
        try {
          statSync(candidate)
        } catch (error: unknown) {
          if (isENOENT(error)) continue
          unresolved = true
          continue
        }
        let bundleIdentifier: string | undefined
        try {
          bundleIdentifier = await this.tools.bundleIdentifier(candidate, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        if (bundleIdentifier === undefined) {
          unresolved = true
          continue
        }
        if (bundleIdentifier !== this.product.macOS.bundleId) continue
        const electronPath = join(candidate, 'Contents', 'MacOS', 'Electron')
        if (!isExecutable(electronPath)) continue
        let identity: string
        try {
          identity = realpathSync(candidate)
        } catch {
          identity = candidate
        }
        if (seen.has(identity)) continue
        let version: string | undefined
        try {
          version = await this.tools.bundleVersion(candidate, controller.signal)
        } catch {
          // Version is display-only; an unreadable one must not sink an
          // otherwise identified candidate.
          version = undefined
        }
        seen.set(identity, { bundlePath: candidate, electronPath, ...version === undefined ? {} : { version } })
      }
      if (seen.size > 1) {
        const listed = [...seen.values()]
          .map(app => `  - ${app.bundlePath}${app.version === undefined ? '' : ` (${app.version})`}`)
          .join('\n')
        throw new WorkBuddyElectronPathError(
          'electron-binary-ambiguous',
          `more than one ${this.product.productName} application was found, so none was chosen:\n${listed}\n`
          + ` set ${this.product.envVar} to the one to use`,
        )
      }
      if (unresolved) throw discoveryIncomplete(this.product.productName, 'some candidates could not be checked')
      if (seen.size === 0) {
        throw new WorkBuddyElectronPathError(
          'electron-binary-not-found',
          `no ${this.product.productName} application was found in the default location or the system index;`
          + ' if it is installed elsewhere, it may not be indexed yet;'
          + ` set ${this.product.envVar} to the app's Electron binary`,
        )
      }
      return [...seen.values()][0]!.electronPath
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  /**
   * Resolve this product's app through Windows uninstall records. Registry
   * entries provide hints, not trust: every DisplayIcon candidate must still
   * be the product's Electron binary with the known Electron layout before
   * execution.
   */
  private async discoverWindowsApp(): Promise<string> {
    if (this.platform !== 'win32') {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no ${this.product.productName} Electron binary is configured for this platform;`
        + ` set ${this.product.envVar} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs)
    try {
      const candidates: string[] = []
      let unresolved = false
      for (const root of WINDOWS_REGISTRY_ROOTS) {
        let output: string
        try {
          output = await this.windowsTools.queryUninstallRoot(root, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        const parsed = parseWindowsRegistryOutput(output, this.product.windows.displayNamePattern)
        candidates.push(...parsed.candidates)
        unresolved ||= parsed.incomplete
      }

      const seen = new Map<string, string>()
      const rejected: string[] = []
      for (const candidate of new Set(candidates)) {
        const inspection = inspectWindowsElectronCandidate(candidate, this.platform, this.product.windows.exeBasename)
        if (inspection === 'unresolved') {
          unresolved = true
          continue
        }
        if (inspection === undefined) {
          rejected.push(candidate)
          continue
        }
        seen.set(inspection.identity, inspection.electronPath)
      }
      if (unresolved) throw discoveryIncomplete(this.product.productName, 'some registry entries or candidates could not be checked')
      if (seen.size > 1) {
        const listed = [...seen.values()].map(path => `  - ${path}`).join('\n')
        throw new WorkBuddyElectronPathError(
          'electron-binary-ambiguous',
          `more than one ${this.product.productName} application was found, so none was chosen:\n${listed}\n`
          + ` set ${this.product.envVar} to the one to use`,
        )
      }
      if (seen.size === 0) {
        const message = rejected.length === 0
          ? `no usable ${this.product.productName} Electron binary was found in the default location or Windows uninstall records;`
            + ` set ${this.product.envVar} to the app's Electron binary`
          : `Windows uninstall records found ${rejected.length} ${this.product.productName} candidate${rejected.length > 1 ? 's' : ''},`
            + ` but ${rejected.length > 1 ? 'none' : 'it'} did not match the expected app layout (the app's exe beside a version file and resources\\app.asar);`
            + ` set ${this.product.envVar} to the installed app's executable to use it`
        throw new WorkBuddyElectronPathError('electron-binary-not-found', message)
      }
      return [...seen.values()][0]!
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  private async spawnPayload(): Promise<string> {
    return await this.spawnHelper(await this.resolveElectronPath())
  }

  private async spawnAt(electronPath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      execFile(electronPath, [HELPER_SCRIPT_ARGUMENT_FLAG, HELPER_SCRIPT], {
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: helperChildEnv(process.env, electronPath, this.wsl()),
      }, (error, stdout) => {
        if (error !== null && error !== undefined) {
          // Code and reason only: stdout/stderr can carry paths or crash dumps,
          // and the payload must never appear in a message.
          const reason = error.killed === true
            ? `timed out or was killed after ${String(this.timeoutMs)}ms`
            : error.code !== undefined
              ? `exited with code ${String(error.code)}`
              : 'could not be started'
          reject(new WorkBuddyElectronPathError(
            'encrypted-credential-unreadable',
            `the WorkBuddy key helper (${electronPath}) ${reason}`,
          ))
          return
        }
        const output = stdout.trim()
        if (output === '') {
          reject(new WorkBuddyElectronPathError(
            'encrypted-credential-unreadable',
            `the WorkBuddy key helper (${electronPath}) produced no payload`,
          ))
          return
        }
        resolve(output)
      })
    })
  }
}

/**
 * Why a finished-but-failed discovery subprocess cannot produce an answer.
 *
 * A size-limit overflow (`maxBuffer`, delivered as
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) gets its own words: reporting it as a
 * timeout would send a user chasing scheduler latency when the machine's
 * uninstall tree is simply larger than the documented cap — a different
 * problem with a different fix. Both stay "incomplete", never "absent".
 */
function subprocessFailureReason(error: { readonly code?: unknown, readonly killed?: boolean }): string {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'the output exceeded the size limit'
  return error.killed === true ? 'timed out' : String(error.code ?? 'unavailable')
}

/** Only known missing-key diagnostics can safely make a failed query empty. */
function windowsRegistryKeyMissing(stderr: string): boolean {
  const detail = stderr.trim()
  return /^ERROR:\s*The system was unable to find the specified registry key or value\.?$/iu.test(detail)
    || /^错误[:：]\s*系统找不到指定的注册表项或值[。.]?$/u.test(detail)
}

function windowsRegistryKeyMissingFromBytes(stderr: Buffer): boolean {
  if (windowsRegistryKeyMissing(stderr.toString('utf8'))) return true
  try {
    return windowsRegistryKeyMissing(new TextDecoder('gbk').decode(stderr))
  } catch {
    // A runtime without full ICU cannot decode GBK; stay with UTF-8 only.
    return false
  }
}

/**
 * Parse the value columns emitted by `reg query ... /s`.
 *
 * Entries are filtered by the product's DisplayName pattern *before* the
 * DisplayIcon is judged, so another product's records — however broken — are
 * excluded as decisively not ours and can never mark this product's search
 * incomplete.
 */
export function parseWindowsRegistryOutput(output: string, displayNamePattern: RegExp): { candidates: string[], incomplete: boolean } {
  const entries = new Map<string, { displayName?: string, displayIcon?: string }>()
  let currentKey: string | undefined
  for (const line of output.split(/\r?\n/u)) {
    const keyMatch = /^\s*(HKEY_[^\r\n]+?)\s*$/iu.exec(line)
    if (keyMatch !== null) {
      currentKey = keyMatch[1]!
      entries.set(currentKey, {})
      continue
    }
    if (currentKey === undefined) continue
    const valueMatch = /^\s+(DisplayName|DisplayIcon)\s+REG_[A-Z0-9_]+\s*(.*?)\s*$/iu.exec(line)
    if (valueMatch === null) continue
    const entry = entries.get(currentKey)
    if (entry === undefined) continue
    const value = valueMatch[2] ?? ''
    if (valueMatch[1]!.toLowerCase() === 'displayname') entry.displayName = value
    else entry.displayIcon = value
  }
  const candidates: string[] = []
  let incomplete = false
  for (const entry of entries.values()) {
    if (entry.displayName === undefined) continue
    if (!displayNamePattern.test(entry.displayName.trim())) continue
    const displayIcon = entry.displayIcon === undefined ? undefined : parseWindowsDisplayIcon(entry.displayIcon)
    if (displayIcon === undefined) incomplete = true
    else candidates.push(displayIcon)
  }
  return { candidates, incomplete }
}

/** Read a quoted DisplayIcon path and remove the Windows icon-index suffix. */
export function parseWindowsDisplayIcon(value: string): string | undefined {
  const raw = value.trim()
  let path: string
  if (raw.startsWith('"')) {
    const closingQuote = raw.indexOf('"', 1)
    if (closingQuote < 0) return undefined
    const suffix = raw.slice(closingQuote + 1).trim()
    if (suffix !== '' && !/^,\d+$/u.test(suffix)) return undefined
    path = raw.slice(1, closingQuote).replace(/,\d+$/u, '')
  } else {
    const match = /^(.+?\.exe)(?:,\d+)?$/iu.exec(raw)
    if (match === null) return undefined
    path = match[1]!
  }
  path = path.trim()
  return /\.exe$/iu.test(path) ? path : undefined
}

interface WindowsCandidateInspection {
  electronPath: string
  identity: string
}

/**
 * Validate the known Windows layout for the product's exe. `undefined` is a
 * decidable exclusion; `unresolved` is reserved for errors that prevent
 * checking.
 */
function inspectWindowsElectronCandidate(
  electronPath: string,
  platform: NodeJS.Platform,
  exeBasename: string,
): WindowsCandidateInspection | 'unresolved' | undefined {
  if (platform !== 'win32' || basename(electronPath).toLowerCase() !== exeBasename) return undefined
  let binaryStat
  try {
    binaryStat = statSync(electronPath)
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  if (!binaryStat.isFile()) return undefined
  try {
    accessSync(electronPath, constants.X_OK)
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }

  const installRoot = dirname(electronPath)
  let version: string
  try {
    version = readFileSync(join(installRoot, 'version'), 'utf8').trim()
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  if (!WINDOWS_ELECTRON_VERSION_PATTERN.test(version)) return undefined

  try {
    if (!readdirSync(join(installRoot, 'resources')).includes('app.asar')) return undefined
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }

  let identity: string
  try {
    identity = realpathSync(electronPath)
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  return {
    electronPath,
    // Windows paths are case-insensitive even when a registry entry preserved
    // a different casing from the filesystem spelling.
    identity: platform === 'win32' ? identity.toLowerCase() : identity,
  }
}

/** Whether a path exists and is executable; never throws. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A failure the card must be able to classify. The code travels with the error
 * so the store can promote it to `reasonCode` without re-deriving the cause
 * from prose.
 */
export class WorkBuddyElectronPathError extends Error {
  readonly reasonCode: WorkBuddySignedOutReasonCode

  constructor(reasonCode: WorkBuddySignedOutReasonCode, message: string) {
    super(message)
    this.name = 'WorkBuddyElectronPathError'
    this.reasonCode = reasonCode
  }
}

/** Read the reason code off an arbitrary thrown value, when it carries one. */
export function reasonCodeOf(error: unknown): WorkBuddySignedOutReasonCode | undefined {
  return error instanceof WorkBuddyElectronPathError ? error.reasonCode : undefined
}

/** Whether a filesystem error reports an absent path (`existsSync` cannot tell). */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function discoveryIncomplete(productName: string, detail: string): WorkBuddyElectronPathError {
  return new WorkBuddyElectronPathError(
    'electron-discovery-incomplete',
    `the ${productName} application search did not finish (${detail});`
    + ' this is not proof that the app is missing',
  )
}

/**
 * The helper: run inside WorkBuddy's Electron as plain Node, where the
 * private `workbuddyStorage` binding exists, and print only the payload. It
 * writes nothing else, so whatever reaches stdout is the payload.
 */
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'
const HELPER_SCRIPT_ARGUMENT_FLAG = '-e'
