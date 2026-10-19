/**
 * Desktop sign-in reader: path discovery, safeStorage decryption, document
 * parsing and token rotation. Every OS read is injected, so no test touches the
 * real Keychain, DPAPI or the developer's Qoder app data.
 */
import { createCipheriv } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  clearDesktopSecretCache,
  decryptSafeStorageValue,
  deriveSafeStorageKey,
  desktopAuthCandidatePaths,
  parseQoderAuthDocument,
  readQoderDesktopAuth,
  refreshQoderDeviceToken,
} from '../../../src/providers/qoder/desktop-auth.ts'
import { QODER_CN_VARIANT, QODER_GLOBAL_VARIANT } from '../../../src/providers/qoder/variants.ts'

const FIXED_SECRET = Buffer.from('test-only-keychain-secret')
const SAFE_STORAGE_IV = Buffer.alloc(16, 0x20)

/** Encrypt a plaintext exactly the way Chromium's safeStorage writes `v10`. */
function seal(plaintext: string, secret = FIXED_SECRET): Buffer {
  const cipher = createCipheriv('aes-128-cbc', deriveSafeStorageKey(secret), SAFE_STORAGE_IV)
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext, 'utf8'), cipher.final()])
}

/** The decrypted document the Qoder desktop app writes today. */
const CREDENTIAL_DOCUMENT = {
  schemaVersion: 1,
  token: 'dt-token-from-desktop',
  refreshToken: 'drt-refresh-from-desktop',
  expiresAt: '2026-10-21T16:52:02Z',
  refreshTokenExpiresAt: '2027-09-16T16:52:02Z',
  user: { id: 'user-123', name: 'Tester', email: 'tester@example.com', phone: '', avatarUrl: 'https://example.com/a.png' },
}

function macOptions(files: Map<string, Buffer>, secret = FIXED_SECRET) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    home: '/Users/tester',
    env: {},
    readFile: async (path: string) => {
      const value = files.get(path)
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return value
    },
    readSecret: async () => secret,
  }
}

const CN_PATH = desktopAuthCandidatePaths(QODER_CN_VARIANT, { platform: 'darwin', home: '/Users/tester', env: {} })[0]!
const GLOBAL_PATH = desktopAuthCandidatePaths(QODER_GLOBAL_VARIANT, { platform: 'darwin', home: '/Users/tester', env: {} })[0]!

describe('desktopAuthCandidatePaths', () => {
  it('probes the macOS userData directory per region', () => {
    expect(CN_PATH).toBe('/Users/tester/Library/Application Support/com.qodercn.app.stable/auth.v1.dat')
    expect(GLOBAL_PATH).toBe('/Users/tester/Library/Application Support/com.qoder.app.stable/auth.v1.dat')
  })

  it('probes both Windows AppData roots and dedupes equal ones', () => {
    const paths = desktopAuthCandidatePaths(QODER_CN_VARIANT, {
      platform: 'win32',
      home: 'C:/Users/tester',
      env: { APPDATA: 'C:/Users/tester/AppData/Roaming' },
    })
    expect(paths[0]).toBe('C:/Users/tester/AppData/Roaming/com.qodercn.app.stable/auth.v1.dat')
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths.length).toBe(2)
  })

  it('probes the XDG config home on Linux', () => {
    const paths = desktopAuthCandidatePaths(QODER_GLOBAL_VARIANT, {
      platform: 'linux',
      home: '/home/tester',
      env: { XDG_CONFIG_HOME: '/home/tester/.config-custom' },
    })
    expect(paths).toEqual(['/home/tester/.config-custom/com.qoder.app.stable/auth.v1.dat'])
  })

  it('lets the region env override replace every platform default', () => {
    const paths = desktopAuthCandidatePaths(QODER_CN_VARIANT, {
      platform: 'darwin',
      home: '/Users/tester',
      env: { DSH_CONNECT_HUB_QODER_CN_AUTH_FILE: '/custom/auth.v1.dat' },
    })
    expect(paths).toEqual(['/custom/auth.v1.dat'])
  })
})

describe('parseQoderAuthDocument', () => {
  it('reads the token pair, ISO expiries and account fields', () => {
    const credential = parseQoderAuthDocument(JSON.stringify(CREDENTIAL_DOCUMENT))
    expect(credential).toEqual({
      token: 'dt-token-from-desktop',
      refreshToken: 'drt-refresh-from-desktop',
      expiresAtMs: Date.parse('2026-10-21T16:52:02Z'),
      refreshTokenExpiresAtMs: Date.parse('2027-09-16T16:52:02Z'),
      user: { id: 'user-123', name: 'Tester', email: 'tester@example.com' },
    })
  })

  it('accepts numeric expiries in seconds and milliseconds', () => {
    const seconds = parseQoderAuthDocument(JSON.stringify({ token: 't', refreshToken: 'r', expiresAt: 1_800_000_000 }))
    expect(seconds?.expiresAtMs).toBe(1_800_000_000_000)
    const millis = parseQoderAuthDocument(JSON.stringify({ token: 't', expiresAt: 1_800_000_000_000 }))
    expect(millis?.expiresAtMs).toBe(1_800_000_000_000)
  })

  it('tolerates a record without a user block or refresh token', () => {
    const credential = parseQoderAuthDocument(JSON.stringify({ token: 't', expiresAt: 'not-a-date' }))
    expect(credential).toMatchObject({ token: 't', refreshToken: '', expiresAtMs: 0, user: { id: '' } })
  })

  it('rejects documents without a token or without JSON', () => {
    expect(parseQoderAuthDocument('not json')).toBeUndefined()
    expect(parseQoderAuthDocument(JSON.stringify({ refreshToken: 'r' }))).toBeUndefined()
    expect(parseQoderAuthDocument(JSON.stringify(['token']))).toBeUndefined()
  })
})

describe('decryptSafeStorageValue', () => {
  it('round-trips the Chromium v10 format', () => {
    const sealed = seal('{"token":"t"}')
    expect(decryptSafeStorageValue(deriveSafeStorageKey(FIXED_SECRET), sealed).toString('utf8')).toBe('{"token":"t"}')
  })

  it('rejects a wrong prefix, a wrong key and a truncated value', () => {
    const key = deriveSafeStorageKey(FIXED_SECRET)
    const sealed = seal('{"token":"t"}')
    expect(() => decryptSafeStorageValue(key, Buffer.concat([Buffer.from('v11'), sealed.subarray(3)]))).toThrow()
    expect(() => decryptSafeStorageValue(deriveSafeStorageKey(Buffer.from('other')), sealed)).toThrow()
    expect(() => decryptSafeStorageValue(key, Buffer.from('v10'))).toThrow()
  })
})

describe('readQoderDesktopAuth', () => {
  it('reads and decrypts the region app record', async () => {
    clearDesktopSecretCache()
    const result = await readQoderDesktopAuth(QODER_CN_VARIANT, macOptions(new Map([
      [CN_PATH, seal(JSON.stringify(CREDENTIAL_DOCUMENT))],
    ])))
    expect(result.state).toBe('found')
    if (result.state !== 'found') return
    expect(result.path).toBe(CN_PATH)
    expect(result.credential).toMatchObject({
      token: 'dt-token-from-desktop',
      user: { id: 'user-123', name: 'Tester' },
    })
  })

  it('prefers the region override and does not fall back to other regions', async () => {
    clearDesktopSecretCache()
    const files = new Map([
      [CN_PATH, seal(JSON.stringify({ ...CREDENTIAL_DOCUMENT, token: 'global-token-wrong-app' }))],
      [GLOBAL_PATH, seal(JSON.stringify(CREDENTIAL_DOCUMENT))],
    ])
    const result = await readQoderDesktopAuth(QODER_GLOBAL_VARIANT, macOptions(files))
    expect(result).toMatchObject({ state: 'found', path: GLOBAL_PATH })
  })

  it('reports absent when no candidate exists', async () => {
    const result = await readQoderDesktopAuth(QODER_CN_VARIANT, macOptions(new Map()))
    expect(result.state).toBe('absent')
  })

  it('reports a malformed decrypted document instead of throwing', async () => {
    clearDesktopSecretCache()
    const result = await readQoderDesktopAuth(QODER_CN_VARIANT, macOptions(new Map([
      [CN_PATH, seal('{"something":"else"}')],
    ])))
    expect(result).toMatchObject({ state: 'unreadable', code: 'malformed-record' })
  })

  it('reports a decryption failure when the OS secret does not match', async () => {
    clearDesktopSecretCache()
    const result = await readQoderDesktopAuth(QODER_CN_VARIANT, macOptions(new Map([
      [CN_PATH, seal(JSON.stringify(CREDENTIAL_DOCUMENT))],
    ]), Buffer.from('rotated-away-secret')))
    expect(result).toMatchObject({ state: 'unreadable', code: 'unreadable-record' })
  })

  it('re-reads the Keychain secret once when the cached key no longer opens the record', async () => {
    clearDesktopSecretCache()
    let reads = 0
    const result = await readQoderDesktopAuth(QODER_CN_VARIANT, {
      platform: 'darwin',
      home: '/Users/tester',
      env: {},
      readFile: async () => seal(JSON.stringify(CREDENTIAL_DOCUMENT)),
      readSecret: async () => {
        reads += 1
        return reads === 1 ? Buffer.from('stale-key') : FIXED_SECRET
      },
    })
    expect(result.state).toBe('found')
    expect(reads).toBe(2)
  })

  it('reports an empty record and moves on to the next candidate', async () => {
    clearDesktopSecretCache()
    const result = await readQoderDesktopAuth(QODER_CN_VARIANT, macOptions(new Map([
      [CN_PATH, Buffer.alloc(0)],
    ])))
    expect(result).toMatchObject({ state: 'unreadable', code: 'empty-record' })
  })

  it('does not read anything on a platform it cannot open', async () => {
    const readFile = vi.fn()
    const result = await readQoderDesktopAuth(QODER_CN_VARIANT, {
      platform: 'linux',
      home: '/home/tester',
      env: {},
      readFile,
    })
    expect(result).toMatchObject({ state: 'unsupported', code: 'unsupported-platform' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('opens a Windows DPAPI record through the injected unprotector', async () => {
    const plaintext = JSON.stringify(CREDENTIAL_DOCUMENT)
    const dpapiUnprotect = vi.fn(async (blob: Buffer) => {
      expect(blob).toEqual(Buffer.from([1, 2, 3, 4]))
      return Buffer.from(plaintext, 'utf8')
    })
    const path = desktopAuthCandidatePaths(QODER_CN_VARIANT, {
      platform: 'win32',
      home: 'C:/Users/tester',
      env: { APPDATA: 'C:/AppData/Roaming', LOCALAPPDATA: 'C:/AppData/Local' },
    })[0]!
    const result = await readQoderDesktopAuth(QODER_CN_VARIANT, {
      platform: 'win32',
      home: 'C:/Users/tester',
      env: { APPDATA: 'C:/AppData/Roaming', LOCALAPPDATA: 'C:/AppData/Local' },
      readFile: async (candidate: string) => {
        expect(candidate).toBe(path)
        return Buffer.concat([Buffer.from('v10'), Buffer.from([1, 2, 3, 4])])
      },
      dpapiUnprotect,
    })
    expect(result).toMatchObject({ state: 'found' })
    expect(dpapiUnprotect).toHaveBeenCalledTimes(1)
  })
})

describe('refreshQoderDeviceToken', () => {
  const refreshBody = {
    device_token: 'dt-rotated',
    refresh_token: 'drt-rotated',
    token_type: 'Bearer',
    expires_at: '2026-11-17T09:16:27Z',
    refresh_token_expires_at: '2027-10-13T09:16:27Z',
  }

  it('posts the refresh token to the region endpoint and parses the new pair', async () => {
    let captured: { url: string, init: RequestInit } | undefined
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return new Response(JSON.stringify(refreshBody), { status: 200 })
    }) as typeof fetch
    const outcome = await refreshQoderDeviceToken({
      region: 'china',
      refreshToken: 'drt-old',
      fetch: fetchStub,
    })
    expect(outcome).toEqual({
      token: 'dt-rotated',
      refreshToken: 'drt-rotated',
      expiresAtMs: Date.parse('2026-11-17T09:16:27Z'),
      refreshTokenExpiresAtMs: Date.parse('2027-10-13T09:16:27Z'),
    })
    expect(captured?.url).toBe('https://openapi.qoder.com.cn/api/v1/deviceToken/refresh')
    expect(captured?.init.method).toBe('POST')
    expect(JSON.parse(String(captured?.init.body))).toEqual({ refresh_token: 'drt-old' })
    const headers = captured?.init.headers as Record<string, string>
    expect(headers['user-agent']).toMatch(/^qoder\//u)
    expect(headers['content-type']).toBe('application/json')
  })

  it('reports a rejected sign-in for 401/403 and a status for other failures', async () => {
    for (const status of [401, 403]) {
      const unauthorized = (async () => new Response('', { status })) as typeof fetch
      await expect(refreshQoderDeviceToken({ region: 'china', refreshToken: 'drt', fetch: unauthorized }))
        .rejects.toThrow(/重新登录/u)
    }
    const serverError = (async () => new Response('', { status: 500 })) as typeof fetch
    await expect(refreshQoderDeviceToken({ region: 'global', refreshToken: 'drt', fetch: serverError }))
      .rejects.toThrow(/HTTP 500/u)
  })

  it('targets the global deployment for the global route', async () => {
    let url = ''
    const fetchStub = (async (input: string | URL | Request) => {
      url = String(input)
      return new Response(JSON.stringify(refreshBody), { status: 200 })
    }) as typeof fetch
    await refreshQoderDeviceToken({ region: 'global', refreshToken: 'drt', fetch: fetchStub })
    expect(url).toBe('https://openapi.qoder.sh/api/v1/deviceToken/refresh')
  })

  it('classifies a queue rejection as busy instead of a dead sign-in', async () => {
    const busy = (async () => new Response(JSON.stringify({ code: 10605, isQueued: true }), { status: 401 })) as typeof fetch
    await expect(refreshQoderDeviceToken({ region: 'china', refreshToken: 'drt', fetch: busy }))
      .rejects.toThrow(/繁忙/u)
  })

  it('rejects a malformed answer and an empty refresh token', async () => {
    const malformed = (async () => new Response(JSON.stringify({ device_token: 'only-one' }), { status: 200 })) as typeof fetch
    await expect(refreshQoderDeviceToken({ region: 'china', refreshToken: 'drt', fetch: malformed }))
      .rejects.toThrow(/令牌对/u)
    await expect(refreshQoderDeviceToken({ region: 'china', refreshToken: '  ', fetch: malformed }))
      .rejects.toThrow(/缺少刷新令牌/u)
  })
})
