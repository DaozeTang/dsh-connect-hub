/**
 * Desktop app version discovery for request headers.
 *
 * The version is read from the macOS app bundle when available, remembered
 * across runs, and finally replaced by a compiled-in constant. A missing app or
 * unreadable metadata never blocks a request.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PrefsStore } from '../../core/prefs.ts'

/**
 * Last-resort version for the international product. The gateway ignores the
 * numbers when splitting the user agent, so this is a shape requirement, not a
 * claim about the installed app.
 */
export const FALLBACK_APP_VERSION = '5.5.2'

/** Last-resort version for the CN product (same reasoning). */
export const FALLBACK_CN_APP_VERSION = '5.5.6'

/** Where a resolved version came from. */
export type WorkBuddyAppVersionSource = 'installed' | 'saved' | 'fallback'

/** Resolved version plus where it was read from. */
export interface AppVersionInfo {
  version: string
  source: WorkBuddyAppVersionSource
  /** Absolute path of the App bundle the version was read from, when installed. */
  bundle?: string
}

/** Version string shape accepted for headers and persisted caches. */
const VERSION_SHAPE = /^\d{1,6}(?:\.\d{1,6}){1,3}$/u

/** `<key>CFBundleShortVersionString</key><string>…</string>` in an XML plist. */
const SHORT_VERSION_PLIST_ENTRY = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/u

/**
 * Whether a value is a version safe to interpolate into an HTTP header.
 * Anything that could split the request (CR, LF, spaces) is rejected.
 */
export function validAppVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_SHAPE.test(value)
}

/** macOS App-bundle roots: system-wide first, then the user's own install. */
function macBundleRoots(): string[] {
  return ['/Applications', join(homedir(), 'Applications')]
}

/** Read the short version out of one Info.plist document. */
function shortVersionFromPlist(text: string): string | undefined {
  const captured = SHORT_VERSION_PLIST_ENTRY.exec(text)?.[1]?.trim()
  return captured !== undefined && validAppVersion(captured) ? captured : undefined
}

/** Read `CFBundleShortVersionString` from one Info.plist file. */
export async function readBundleVersion(plistPath: string): Promise<string | undefined> {
  try {
    return shortVersionFromPlist(await readFile(plistPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** One installed app bundle and the version read from it. */
interface InstalledVersion {
  version: string
  bundle: string
}

/**
 * The installed app's version and bundle path, or `undefined` when the app is
 * not installed or its metadata is unreadable. No path is guessed on platforms
 * without a verified bundle layout.
 */
export async function installedAppVersion(bundleName = 'WorkBuddy AI.app'): Promise<InstalledVersion | undefined> {
  if (process.platform !== 'darwin') return undefined
  for (const root of macBundleRoots()) {
    const bundle = join(root, bundleName)
    const version = await readBundleVersion(join(bundle, 'Contents', 'Info.plist'))
    if (version !== undefined) return { version, bundle }
  }
  return undefined
}

/** Extract a version from the persisted cache document. */
function cachedVersion(stored: unknown): string | undefined {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined
  const version = (stored as Record<string, unknown>)['version']
  return validAppVersion(version) ? version : undefined
}

/**
 * A persisted memory of the last resolved version, so a later move or
 * uninstall still leaves a real version to fall back on.
 */
export class VersionCache {
  private readonly prefs: Pick<PrefsStore, 'get' | 'set'>
  private readonly key: string
  private current: string | undefined

  constructor(prefs: Pick<PrefsStore, 'get' | 'set'>, key: string) {
    this.prefs = prefs
    this.key = key
  }

  /** Load the persisted value once; call before the first status read. */
  async load(): Promise<void> {
    this.current = cachedVersion(await this.prefs.get<unknown>(this.key))
  }

  /** The persisted version, or undefined when none was ever saved. */
  get(): string | undefined {
    return this.current
  }

  /** Remember a resolved version; a failed write is not a failure. */
  async remember(version: string): Promise<void> {
    if (!validAppVersion(version)) return
    this.current = version
    try {
      await this.prefs.set(this.key, { version, observedAt: Date.now() })
    } catch {
      // The caller already holds a usable version; losing the memory is harmless.
    }
  }
}

/** Constructor dependencies; injectable so tests never touch the real filesystem. */
export interface ResolveAppVersionOptions {
  /** Persisted version memory; absent skips the saved step. */
  cache?: VersionCache
  /** Installed-version reader; defaults to {@link installedAppVersion}. */
  installed?: () => Promise<InstalledVersion | undefined>
  /** Bundle name probed by the default reader. */
  bundleName?: string
}

/**
 * Resolve the version to advertise: installed app first, then the saved value,
 * then the compiled-in constant. A found version is remembered best-effort.
 */
export async function resolveAppVersion(options: ResolveAppVersionOptions = {}): Promise<AppVersionInfo> {
  const probeInstalled = options.installed ?? (() => installedAppVersion(options.bundleName))
  const installed = await probeInstalled()
  if (installed !== undefined && validAppVersion(installed.version)) {
    await options.cache?.remember(installed.version)
    return { version: installed.version, source: 'installed', bundle: installed.bundle }
  }
  const saved = options.cache?.get()
  if (saved !== undefined) return { version: saved, source: 'saved' }
  return { version: FALLBACK_APP_VERSION, source: 'fallback' }
}

/** Build the app-shaped user agent for catalog requests. */
export function appUserAgent(version: string): string {
  if (!validAppVersion(version)) {
    throw new Error(`invalid WorkBuddy AI version for User-Agent: ${JSON.stringify(version)}`)
  }
  return `WorkBuddyAI/${version}`
}
