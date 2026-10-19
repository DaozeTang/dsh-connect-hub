/**
 * Desktop-client identity for chat and probe requests.
 *
 * Those requests present the same user-agent shape as the desktop client:
 * `WorkBuddy/<version> <product>/<version> CLI/<cli>`. The version is read from
 * the installed app, remembered per region, and finally replaced by a built-in
 * constant; a CLI version that does not resolve simply drops the `CLI/` token.
 * Catalog, billing, and token-refresh requests keep their own headers.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FALLBACK_APP_VERSION,
  FALLBACK_CN_APP_VERSION,
  installedAppVersion,
  resolveAppVersion,
  validAppVersion,
  type AppVersionInfo,
  type VersionCache,
} from './app-version.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** The identity a chat request presents as. */
export interface ChatIdentity {
  /** Desktop App version; drives the user agent and `X-IDE-Version`. */
  clientVersion: string
  /** Bundled agent-CLI version; absent drops the `CLI/` token. */
  cliVersion?: string
}

/** Accepted CLI version shape, including an optional prerelease suffix. */
const CLI_VERSION_SHAPE = /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u

/** The bundled agent CLI's metadata inside the app bundle. */
const CLI_PACKAGE_RELATIVE_PATH = ['Contents', 'Resources', 'app.asar.unpacked', 'cli', 'package.json']

/** Placeholder `version` the CLI package ships instead of a real value. */
const CLI_PLACEHOLDER_VERSION = '0.0.0'

/** CN product app bundle name. */
const CN_APP_BUNDLE = 'WorkBuddy.app'

/** Whether a value is a CLI version safe to interpolate into a header. */
export function validCliVersion(value: unknown): value is string {
  return typeof value === 'string' && CLI_VERSION_SHAPE.test(value)
}

/** The bundled CLI's package.json path inside one app bundle. */
function cliPackagePath(bundle: string): string {
  return join(bundle, ...CLI_PACKAGE_RELATIVE_PATH)
}

/** A non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The real CLI version declared by one package.json document. */
function cliVersionFromPackage(document: unknown): string | undefined {
  if (!isRecord(document)) return undefined
  const declared = document['version']
  if (validCliVersion(declared) && declared !== CLI_PLACEHOLDER_VERSION) return declared
  const publishConfig = document['publishConfig']
  if (!isRecord(publishConfig)) return undefined
  const customPackage = publishConfig['customPackage']
  if (!isRecord(customPackage)) return undefined
  const customVersion = customPackage['version']
  return validCliVersion(customVersion) ? customVersion : undefined
}

/**
 * The bundled agent CLI's real version, or `undefined` when its metadata does
 * not resolve. The package's `version` is a placeholder, so the custom package
 * version is the fallback source.
 */
export async function readCliVersion(bundle: string): Promise<string | undefined> {
  let document: unknown
  try {
    document = JSON.parse(await readFile(cliPackagePath(bundle), 'utf8'))
  } catch {
    return undefined
  }
  return cliVersionFromPackage(document)
}

/**
 * Build the chat user agent for one region. Throws on an invalid version rather
 * than interpolating one into a header; callers only pass resolved identities.
 */
export function chatUserAgent(identity: ChatIdentity, region: WorkBuddyRegion): string {
  if (!validAppVersion(identity.clientVersion)) {
    throw new Error(`invalid client version for chat User-Agent: ${JSON.stringify(identity.clientVersion)}`)
  }
  if (identity.cliVersion !== undefined && !validCliVersion(identity.cliVersion)) {
    throw new Error(`invalid CLI version for chat User-Agent: ${JSON.stringify(identity.cliVersion)}`)
  }
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  const tokens = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`]
  if (identity.cliVersion !== undefined) tokens.push(`CLI/${identity.cliVersion}`)
  return tokens.join(' ')
}

/** The region's built-in identity: desktop shape, built-in version, no CLI token. */
export function fallbackChatIdentity(region: WorkBuddyRegion): ChatIdentity {
  return { clientVersion: region === 'global' ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION }
}

/** Constructor dependencies; every reader is injectable so tests stay offline. */
export interface ResolveChatIdentityOptions {
  /** Persisted CN App version memory. */
  cacheCn?: VersionCache
  /** Persisted international App version memory (shared with the catalog user agent). */
  cacheIntl?: VersionCache
  /** Installed CN desktop-bundle reader; defaults to the macOS probe. */
  installedCn?: () => Promise<{ version: string; bundle: string } | undefined>
  /** International version resolver; defaults to the installed → saved → fallback chain. */
  resolveIntl?: () => Promise<AppVersionInfo>
  /** CLI-version reader; defaults to reading the bundle's `cli/package.json`. */
  cliVersion?: (bundle: string) => Promise<string | undefined>
}

/** The installed CN desktop bundle, when present. */
function installedCnBundle(): Promise<{ version: string; bundle: string } | undefined> {
  return installedAppVersion(CN_APP_BUNDLE)
}

/** The CLI version for one installed bundle, only when it is safe for a header. */
async function cliVersionOf(
  bundle: string,
  reader: (bundle: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const version = await reader(bundle)
  return version !== undefined && validCliVersion(version) ? version : undefined
}

/** CN: installed app → saved version → built-in constant. */
async function resolveCnIdentity(options: ResolveChatIdentityOptions): Promise<ChatIdentity> {
  const readInstalled = options.installedCn ?? installedCnBundle
  const installed = await readInstalled()
  if (installed !== undefined && validAppVersion(installed.version)) {
    const cliVersion = await cliVersionOf(installed.bundle, options.cliVersion ?? readCliVersion)
    const identity: ChatIdentity = {
      clientVersion: installed.version,
      ...(cliVersion === undefined ? {} : { cliVersion }),
    }
    await options.cacheCn?.remember(identity.clientVersion)
    return identity
  }
  const saved = options.cacheCn?.get()
  return saved === undefined ? fallbackChatIdentity('cn') : { clientVersion: saved }
}

/** International: the same installed → saved → fallback chain the catalog UA reads. */
async function resolveGlobalIdentity(options: ResolveChatIdentityOptions): Promise<ChatIdentity> {
  const resolve = options.resolveIntl
    ?? (() => resolveAppVersion(options.cacheIntl === undefined ? {} : { cache: options.cacheIntl }))
  const info = await resolve()
  const clientVersion = validAppVersion(info.version) ? info.version : FALLBACK_APP_VERSION
  const cliVersion = info.bundle === undefined
    ? undefined
    : await cliVersionOf(info.bundle, options.cliVersion ?? readCliVersion)
  return { clientVersion, ...(cliVersion === undefined ? {} : { cliVersion }) }
}

/**
 * Resolve the chat identity for one region, memoized per region. A resolution
 * failure degrades to {@link fallbackChatIdentity} without being cached, so a
 * later call can still resolve properly.
 */
export function createChatIdentityResolver(
  options: ResolveChatIdentityOptions = {},
): (region: WorkBuddyRegion) => Promise<ChatIdentity> {
  const resolved = new Map<WorkBuddyRegion, ChatIdentity>()
  return async (region) => {
    const memo = resolved.get(region)
    if (memo !== undefined) return memo
    let identity: ChatIdentity
    try {
      identity = region === 'global' ? await resolveGlobalIdentity(options) : await resolveCnIdentity(options)
    } catch {
      return fallbackChatIdentity(region)
    }
    resolved.set(region, identity)
    return identity
  }
}
