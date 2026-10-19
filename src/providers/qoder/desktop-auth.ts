/**
 * Read the Qoder desktop app's saved sign-in.
 *
 * The app persists one JSON credential document in its Electron userData
 * directory, sealed with the OS credential store (Keychain on macOS, DPAPI on
 * Windows, Chromium's safeStorage format in both cases). The hub reads that
 * file read-only: it never edits the app's own sign-in, and refreshes rotate
 * into the hub's vault instead.
 *
 * The signed-in device token is directly usable as the job token the Qoder
 * gateway takes, so an imported sign-in needs no Personal Access Token at all.
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { qoderQueueSignal } from './qoder/errors.ts'
import { getQoderDeviceRefreshUrl, type QoderRegion } from './qoder/transport/endpoints.ts'
import { readLimitedText } from './qoder/transport/request.ts'
import { defaultUserAgent } from './qoder/transport/wire/cosy.ts'
import { QODER_DESKTOP_AUTH_FILENAMES, type QoderVariant } from './variants.ts'

/** The part of the app's account record the hub needs. */
export interface QoderDesktopUser {
  /** Upstream user id; empty when the record omitted it. */
  id: string
  name?: string
  email?: string
}

/** A token pair read from the Qoder desktop app. */
export interface QoderDesktopCredential {
  token: string
  refreshToken: string
  /** Epoch milliseconds; 0 when the record carried no parseable expiry. */
  expiresAtMs: number
  refreshTokenExpiresAtMs?: number
  user: QoderDesktopUser
}

/** Machine-readable reason a desktop sign-in could not be read. */
export type QoderDesktopFailureCode =
  | 'unsupported-platform'
  | 'not-found'
  | 'empty-record'
  | 'unreadable-record'
  | 'malformed-record'

/** Outcome of probing the desktop app's saved sign-in. */
export type QoderDesktopReadResult =
  | { state: 'found'; credential: QoderDesktopCredential; path: string }
  | { state: 'absent'; code: 'not-found'; checked: readonly string[] }
  | { state: 'unsupported'; code: 'unsupported-platform'; reason: string; checked: readonly string[] }
  | { state: 'unreadable'; code: Exclude<QoderDesktopFailureCode, 'unsupported-platform' | 'not-found'>; reason: string; path?: string }

/** Test seams and environment overrides for {@link readQoderDesktopAuth}. */
export interface QoderDesktopReadOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  /** Replace the raw file read (tests only). */
  readFile?: (path: string) => Promise<Buffer>
  /** Replace the OS credential-store lookup (tests only). */
  readSecret?: (service: string, account: string) => Promise<Buffer>
  /** Replace the Windows DPAPI unprotect step (tests only). */
  dpapiUnprotect?: (blob: Buffer) => Promise<Buffer>
}

/** A rotated device token pair. */
export interface QoderDeviceRefreshOutcome {
  token: string
  refreshToken: string
  expiresAtMs: number
  refreshTokenExpiresAtMs?: number
}

export interface QoderDeviceRefreshOptions {
  region: QoderRegion
  refreshToken: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch
}

/** Chromium OSCrypt constants; identical in every Electron app that stores this way. */
const SAFE_STORAGE_SALT = 'saltysalt'
const SAFE_STORAGE_ROUNDS = 1003
const SAFE_STORAGE_KEY_BYTES = 16
const SAFE_STORAGE_PREFIX = Buffer.from('v10')
const DPAPI_PREFIX = Buffer.from('DPAPI')
const SAFE_STORAGE_IV = Buffer.alloc(16, 0x20)

/** Platforms this reader can open a credential document on. */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'win32'])

/** Keychain reads are cached for the process; one prompt at most per app. */
const secretCache = new Map<string, Buffer>()

/** Drop cached OS key material; tests call this between cases. */
export function clearDesktopSecretCache(): void {
  secretCache.clear()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Parse an ISO date or a Unix timestamp of either magnitude; 0 when unusable. */
function timestampOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

/** The userData directory bases the desktop app can use on this platform. */
function dataDirectoryBases(variant: QoderVariant, options: QoderDesktopReadOptions): string[] {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const directory = variant.desktop.dataDirectory
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', directory)]
  }
  if (platform === 'win32') {
    const roaming = env['APPDATA']?.trim() || join(home, 'AppData', 'Roaming')
    const local = env['LOCALAPPDATA']?.trim() || join(home, 'AppData', 'Local')
    return [...new Set([join(roaming, directory), join(local, directory)])]
  }
  const configHome = env['XDG_CONFIG_HOME']?.trim() || join(home, '.config')
  return [join(configHome, directory)]
}

/**
 * The auth-store candidates in probe order: an explicit override first, then
 * every known file name under the platform's userData directory.
 */
export function desktopAuthCandidatePaths(
  variant: QoderVariant,
  options: QoderDesktopReadOptions = {},
): string[] {
  const env = options.env ?? process.env
  const override = env[variant.desktop.authFileEnv]?.trim()
  if (override !== undefined && override !== '') return [override]
  const paths: string[] = []
  for (const base of dataDirectoryBases(variant, options)) {
    for (const filename of QODER_DESKTOP_AUTH_FILENAMES) {
      paths.push(join(base, filename))
    }
  }
  return [...new Set(paths)]
}

/** Parse the decrypted sign-in document; undefined when it is not one. */
export function parseQoderAuthDocument(text: string): QoderDesktopCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const token = stringField(parsed, 'token')
  if (token === undefined) return undefined
  const refreshToken = stringField(parsed, 'refreshToken') ?? ''
  const refreshTokenExpiresAtMs = timestampOf(parsed['refreshTokenExpiresAt'])
  const user = isRecord(parsed['user']) ? parsed['user'] : undefined
  const name = user === undefined ? undefined : stringField(user, 'name')
  const email = user === undefined ? undefined : stringField(user, 'email')
  return {
    token,
    refreshToken,
    expiresAtMs: timestampOf(parsed['expiresAt']),
    ...refreshTokenExpiresAtMs === 0 ? {} : { refreshTokenExpiresAtMs },
    user: {
      id: user === undefined ? '' : stringField(user, 'id') ?? '',
      ...name === undefined ? {} : { name },
      ...email === undefined ? {} : { email },
    },
  }
}

/** Run `/usr/bin/security` without a shell, so no argument can be injected. */
function readMacKeychainSecret(service: string, account: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          // Only the exit shape is reported: stderr can name unrelated items.
          reject(new Error(
            `无法读取钥匙串中的 Qoder 登录密钥（${service}）：`
            + (error.killed === true
              ? '读取超时；若 macOS 弹出钥匙串授权提示，请选择“始终允许”后重试'
              : '系统拒绝访问或该条目不存在；请检查钥匙串授权后重试'),
          ))
          return
        }
        const value = stdout.trim()
        if (value === '') {
          reject(new Error(`钥匙串中的 Qoder 登录密钥为空（${service}）`))
          return
        }
        resolve(Buffer.from(value, 'utf8'))
      },
    )
  })
}

/** The 16-byte AES key Chromium derives from the app's Keychain secret. */
export function deriveSafeStorageKey(secret: Buffer): Buffer {
  return pbkdf2Sync(secret, SAFE_STORAGE_SALT, SAFE_STORAGE_ROUNDS, SAFE_STORAGE_KEY_BYTES, 'sha1')
}

/** Decrypt one Chromium `v10` value with its derived key. */
export function decryptSafeStorageValue(key: Buffer, value: Buffer): Buffer {
  if (value.length <= SAFE_STORAGE_PREFIX.length || !value.subarray(0, SAFE_STORAGE_PREFIX.length).equals(SAFE_STORAGE_PREFIX)) {
    throw new Error('Qoder 桌面端登录记录的格式前缀不受支持')
  }
  const ciphertext = value.subarray(SAFE_STORAGE_PREFIX.length)
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, SAFE_STORAGE_IV)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('无法用本机密钥解开 Qoder 桌面端登录记录（可能已被 Qoder 重新加密）')
  }
}

/**
 * Unprotect a DPAPI blob as the current Windows user. The PowerShell child
 * receives the blob through its environment: no shell, no command-line data.
 */
function unprotectWindowsDpapi(blob: Buffer): Promise<Buffer> {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$d=[Convert]::FromBase64String($env:DSH_QODER_DPAPI_BLOB)',
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($d,$null,'CurrentUser')",
    '[Console]::Out.Write([Convert]::ToBase64String($p))',
  ].join(';')
  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, DSH_QODER_DPAPI_BLOB: blob.toString('base64') },
      },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          reject(new Error('无法通过 Windows DPAPI 解开 Qoder 桌面端登录记录'))
          return
        }
        const value = stdout.trim()
        if (value === '') {
          reject(new Error('Windows DPAPI 未返回 Qoder 桌面端登录内容'))
          return
        }
        resolve(Buffer.from(value, 'base64'))
      },
    )
  })
}

/** Decrypt a Windows-format safeStorage value (`v10` + DPAPI blob). */
async function decryptWindowsValue(
  value: Buffer,
  options: QoderDesktopReadOptions,
): Promise<Buffer> {
  const blob = value.subarray(0, SAFE_STORAGE_PREFIX.length).equals(SAFE_STORAGE_PREFIX)
    ? value.subarray(SAFE_STORAGE_PREFIX.length)
    : value.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)
      ? value.subarray(DPAPI_PREFIX.length)
      : undefined
  if (blob === undefined) throw new Error('Qoder 桌面端登录记录的格式前缀不受支持')
  if (options.dpapiUnprotect !== undefined) return await options.dpapiUnprotect(blob)
  return await unprotectWindowsDpapi(blob)
}

/** Open a desktop record with the platform's OS credential store. */
async function decryptDesktopRecord(
  raw: Buffer,
  variant: QoderVariant,
  options: QoderDesktopReadOptions,
): Promise<Buffer> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    const service = `${variant.desktop.appName} Safe Storage`
    const account = `${variant.desktop.appName} Key`
    const readSecret = async (): Promise<Buffer> => options.readSecret === undefined
      ? await readMacKeychainSecret(service, account)
      : await options.readSecret(service, account)
    let secret = secretCache.get(service)
    if (secret === undefined) {
      secret = await readSecret()
      secretCache.set(service, secret)
    }
    try {
      return decryptSafeStorageValue(deriveSafeStorageKey(secret), raw)
    } catch {
      // The app can recreate its safeStorage key (reinstall, data reset). The
      // cached secret is then stale for this whole process, so evict it and
      // retry exactly once with a fresh Keychain read.
      secretCache.delete(service)
      const fresh = await readSecret()
      secretCache.set(service, fresh)
      return decryptSafeStorageValue(deriveSafeStorageKey(fresh), raw)
    }
  }
  if (platform === 'win32') return await decryptWindowsValue(raw, options)
  throw new Error('当前平台暂不支持自动读取 Qoder 桌面端登录')
}

/** Read one candidate file into a decoded credential, or explain why not. */
async function readCandidate(
  path: string,
  variant: QoderVariant,
  options: QoderDesktopReadOptions,
): Promise<QoderDesktopReadResult | undefined> {
  let raw: Buffer
  try {
    raw = options.readFile === undefined ? await readFile(path) : await options.readFile(path)
  } catch (error: unknown) {
    if (isENOENT(error)) return undefined
    return { state: 'unreadable', code: 'unreadable-record', reason: '无法读取 Qoder 桌面端登录记录（权限或磁盘错误）', path }
  }
  if (raw.length === 0) {
    return { state: 'unreadable', code: 'empty-record', reason: 'Qoder 桌面端登录记录为空', path }
  }
  let plaintext: Buffer
  try {
    plaintext = await decryptDesktopRecord(raw, variant, options)
  } catch (error: unknown) {
    return {
      state: 'unreadable',
      code: 'unreadable-record',
      reason: error instanceof Error ? error.message : '无法解密 Qoder 桌面端登录记录',
      path,
    }
  }
  const credential = parseQoderAuthDocument(plaintext.toString('utf8'))
  if (credential === undefined) {
    return { state: 'unreadable', code: 'malformed-record', reason: 'Qoder 桌面端登录记录的内容无法识别', path }
  }
  return { state: 'found', credential, path }
}

/**
 * Probe this deployment's desktop app and return its saved sign-in.
 *
 * Read-only and failure-tolerant: every reason a sign-in cannot be read is
 * reported as a value, never thrown, so a status read or startup never dies on
 * a missing app, a locked Keychain, or a revised on-disk format.
 */
export async function readQoderDesktopAuth(
  variant: QoderVariant,
  options: QoderDesktopReadOptions = {},
): Promise<QoderDesktopReadResult> {
  const platform = options.platform ?? process.platform
  const paths = desktopAuthCandidatePaths(variant, options)
  const unsupported: QoderDesktopReadResult = {
    state: 'unsupported',
    code: 'unsupported-platform',
    reason: '当前平台暂不支持自动读取 Qoder 桌面端登录',
    checked: paths,
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) return unsupported
  let sawEmpty = false
  for (const path of paths) {
    const result = await readCandidate(path, variant, options)
    if (result === undefined) continue
    if (result.state === 'unreadable' && result.code === 'empty-record') {
      sawEmpty = true
      continue
    }
    return result
  }
  return sawEmpty
    ? { state: 'unreadable', code: 'empty-record', reason: 'Qoder 桌面端登录记录为空' }
    : { state: 'absent', code: 'not-found', checked: paths }
}

/** Rotation request headers shared by the refresh call; no secrets here. */
function refreshHeaders(): Record<string, string> {
  return {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'content-type': 'application/json',
    'user-agent': defaultUserAgent,
    'cosy-version': '1.0.1',
    'cosy-clienttype': '5',
  }
}

/**
 * Rotate the desktop sign-in's device token pair.
 *
 * The upstream keeps the previous refresh token valid, so rotating here never
 * breaks the desktop app's own renewal. A rejected token (401/403) means the
 * sign-in is gone upstream and only a new sign-in can fix it.
 */
export async function refreshQoderDeviceToken(
  options: QoderDeviceRefreshOptions,
): Promise<QoderDeviceRefreshOutcome> {
  const refreshToken = options.refreshToken.trim()
  if (refreshToken === '') throw new Error('Qoder 桌面端登录缺少刷新令牌，请在 Qoder 中重新登录')
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal])
  let response: Response
  try {
    response = await fetchImpl(getQoderDeviceRefreshUrl(options.region), {
      method: 'POST',
      headers: refreshHeaders(),
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal,
    })
  } catch {
    if (options.signal?.aborted) throw new Error('Qoder 桌面端登录刷新已取消')
    if (timeoutSignal.aborted) throw new Error('Qoder 桌面端登录刷新超时，请稍后重试')
    throw new Error('无法连接 Qoder 刷新桌面端登录，请检查网络后重试')
  }
  if (!response.ok) {
    let body = ''
    try {
      body = await readLimitedText(response, 64 * 1024, 'Qoder 桌面端登录刷新响应')
    } catch {
      body = ''
    }
    const queue = qoderQueueSignal(body)
    if (queue !== undefined) {
      throw new Error('Qoder 服务繁忙，请稍后重试桌面端登录续期')
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new Error('Qoder 桌面端登录已失效，请在 Qoder 应用中重新登录')
    }
    throw new Error(`Qoder 桌面端登录刷新失败（HTTP ${response.status}）`)
  }
  let parsed: unknown
  try {
    const body = await readLimitedText(response, 64 * 1024, 'Qoder 桌面端登录刷新响应')
    parsed = JSON.parse(body)
  } catch {
    throw new Error('Qoder 桌面端登录刷新返回了无法解析的内容')
  }
  if (!isRecord(parsed)) throw new Error('Qoder 桌面端登录刷新返回了无法识别的内容')
  const token = stringField(parsed, 'device_token')
  const rotated = stringField(parsed, 'refresh_token')
  if (token === undefined || rotated === undefined) {
    throw new Error('Qoder 桌面端登录刷新没有返回新的令牌对')
  }
  const refreshTokenExpiresAtMs = timestampOf(parsed['refresh_token_expires_at'])
  return {
    token,
    refreshToken: rotated,
    expiresAtMs: timestampOf(parsed['expires_at']),
    ...refreshTokenExpiresAtMs === 0 ? {} : { refreshTokenExpiresAtMs },
  }
}
