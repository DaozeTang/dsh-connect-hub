import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyAtRestKeyProvider,
  DSH_CONNECT_HUB_WORKBUDDY_ELECTRON_BIN_ENV,
  buildAuthenticatedContextAad,
  classifyDesktopAuthDocument,
  deriveProtectorKey,
  keyIdsOf,
  openAuthField,
  parseAtRestPayload,
  unwrapDesktopAuthDocument,
} from '../../../src/providers/workbuddy/desktop-credential-protection.ts'
import { sealAuthFieldForTest } from '../../support/wb-seal.ts'
import { CN_VARIANT, AI_VARIANT, electronProfileFor, type WorkBuddyVariant } from '../../../src/providers/workbuddy/variants.ts'

/**
 * All fixtures are synthetic: a fixed test secret, a test-derived protector
 * key, fake tokens. The AAD builder is pinned against a verbatim transcription
 * of the reference implementation, because a silent AAD change is otherwise
 * only detectable as field decryption failures.
 */

const SECRET = Buffer.alloc(32, 7).toString('base64')
const PAYLOAD_TEXT = JSON.stringify({ version: 1, atRestSecretKey: SECRET })
const KEY = deriveProtectorKey(SECRET)
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

const CLEANUPS: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUPS.splice(0).map((cleanup) => cleanup()))
  vi.unstubAllEnvs()
})

/** Verbatim transcription of the reference AAD builder. */
function referenceAad(keyId: string, context: { framing: 'file' | 'field', suite: number }): Buffer {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const framingName = { file: 'WBEF1', field: 'WBEV1' }
  const framingTag = { file: 1, field: 2 }
  const u32 = (value: number): Buffer => {
    const buffer = Buffer.allocUnsafe(4)
    buffer.writeUInt32BE(value)
    return buffer
  }
  const lp = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([u32(bytes.length), bytes])
  }
  return Buffer.concat([
    prefix,
    Buffer.from([1]),
    lp(framingName[context.framing]),
    lp('sym-v1'),
    u32(context.suite),
    lp(keyId),
    Buffer.from([framingTag[context.framing]]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

function sealWithFileFraming(key: Buffer, plaintext: string): { '$wbEncrypted': 1, envelope: string } {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = Buffer.alloc(12, 3)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(referenceAad(keyId, { framing: 'file', suite: 1 }))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/** A full 5.6-shaped desktop document with both token fields sealed. */
function encryptedDocument(key: Buffer = KEY): string {
  return JSON.stringify({
    auth: {
      accessToken: sealAuthFieldForTest(key, 'test-access-token'),
      refreshToken: sealAuthFieldForTest(key, 'test-refresh-token'),
      expiresAt: 1_900_000_000,
      domain: 'www.workbuddy.ai',
    },
    account: { uid: 'uid-9', nickname: 'Tester', enterpriseId: 'ent-3' },
  })
}

describe('desktop auth classification', () => {
  it('reads the four formats apart', () => {
    expect(classifyDesktopAuthDocument('')).toEqual({ format: 'absent' })
    expect(classifyDesktopAuthDocument('   \n')).toEqual({ format: 'absent' })
    expect(classifyDesktopAuthDocument('not json')).toEqual({ format: 'unrecognized' })
    expect(classifyDesktopAuthDocument('[1,2]')).toEqual({ format: 'unrecognized' })
    expect(classifyDesktopAuthDocument('{"auth":{"accessToken":"at","refreshToken":"rt"}}')).toEqual({
      format: 'plaintext',
    })
    const encrypted = classifyDesktopAuthDocument(encryptedDocument())
    expect(encrypted.format).toBe('encrypted')
    if (encrypted.format === 'encrypted') {
      expect(keyIdsOf(encrypted.wrapped.fields)).toEqual([KEY_ID])
      expect(encrypted.wrapped.fields.map((field) => field.field).sort()).toEqual(['accessToken', 'refreshToken'])
    }
  })

  it('treats a wrapper whose envelope will not decode as unrecognized, not encrypted', () => {
    const broken = JSON.stringify({ auth: { accessToken: { '$wbEncrypted': 1, envelope: '%%%not-base64%%%' } } })
    expect(classifyDesktopAuthDocument(broken).format).toBe('unrecognized')
    const truncated = JSON.stringify({
      auth: {
        refreshToken: {
          '$wbEncrypted': 1,
          envelope: Buffer.from(JSON.stringify({ suite: 1, keyId: KEY_ID, nonce: 'AAAA' }), 'utf8').toString('base64'),
        },
      },
    })
    expect(classifyDesktopAuthDocument(truncated).format).toBe('unrecognized')
  })

  it('accepts the flat panel shape and a mixed plaintext/encrypted document', () => {
    const flat = JSON.stringify({
      accessToken: sealAuthFieldForTest(KEY, 'test-access-token'),
      refreshToken: 'plaintext-refresh',
    })
    const classified = classifyDesktopAuthDocument(flat)
    expect(classified.format).toBe('encrypted')
    if (classified.format === 'encrypted') {
      expect(classified.wrapped.fields.map((field) => field.field)).toEqual(['accessToken'])
    }
  })

  it('classifies a wrapper with an unsupported suite as unrecognized, not encrypted', () => {
    const inner = JSON.stringify({
      suite: 2,
      keyId: KEY_ID,
      nonce: Buffer.alloc(12, 1).toString('base64'),
      authTag: Buffer.alloc(16, 1).toString('base64'),
      ciphertext: Buffer.alloc(8, 1).toString('base64'),
    })
    const document = JSON.stringify({
      auth: { accessToken: { '$wbEncrypted': 1, envelope: Buffer.from(inner, 'utf8').toString('base64') } },
    })
    expect(classifyDesktopAuthDocument(document).format).toBe('unrecognized')
  })
})

describe('field decryption', () => {
  it('builds the exact AAD the reference implementation builds for credential fields', () => {
    expect(buildAuthenticatedContextAad('9127dea1b44020a7', 1)).toEqual(
      referenceAad('9127dea1b44020a7', { framing: 'field', suite: 1 }),
    )
  })

  it('round-trips a sealed field and rejects wrong keys or tampered tags', () => {
    const sealed = sealAuthFieldForTest(KEY, 'round-trip')
    const classified = classifyDesktopAuthDocument(JSON.stringify({ auth: { accessToken: sealed } }))
    if (classified.format !== 'encrypted') throw new Error('fixture misclassified')
    const wrapped = classified.wrapped.fields[0]!
    expect(openAuthField(KEY, wrapped.envelope)).toBe('round-trip')
    expect(openAuthField(Buffer.alloc(32, 9), wrapped.envelope)).toBeUndefined()
    const tampered = { ...wrapped.envelope, authTag: Buffer.from(wrapped.envelope.authTag) }
    tampered.authTag[0] = (tampered.authTag[0] ?? 0) ^ 0xff
    expect(openAuthField(KEY, tampered)).toBeUndefined()
  })

  it('rejects an envelope sealed under the file framing instead of guessing', () => {
    const sealed = sealWithFileFraming(KEY, 'file-framed')
    const classified = classifyDesktopAuthDocument(JSON.stringify({ auth: { refreshToken: sealed } }))
    if (classified.format !== 'encrypted') throw new Error('fixture misclassified')
    expect(openAuthField(KEY, classified.wrapped.fields[0]!.envelope)).toBeUndefined()
  })

  it('rebuilt plaintext keeps identity and expiry fields and drops the wrappers', () => {
    const classified = classifyDesktopAuthDocument(encryptedDocument())
    if (classified.format !== 'encrypted') throw new Error('fixture misclassified')
    const text = unwrapDesktopAuthDocument(classified, (field) => `opened-${field.field}`)
    const parsed = JSON.parse(text) as { auth: Record<string, unknown> }
    expect(parsed.auth['accessToken']).toBe('opened-accessToken')
    expect(parsed.auth['refreshToken']).toBe('opened-refreshToken')
    expect(parsed.auth['expiresAt']).toBe(1_900_000_000)
    expect(parsed.auth['domain']).toBe('www.workbuddy.ai')
    expect((parsed.auth['accessToken'] as { $wbEncrypted?: number }).$wbEncrypted).toBeUndefined()
  })
})

describe('at-rest payload validation', () => {
  it('accepts the 5.6 payload shape', () => {
    expect(parseAtRestPayload(PAYLOAD_TEXT)).toEqual({ atRestSecretKey: SECRET })
  })

  it('rejects unparsable, wrong-version, non-canonical, wrong-size, and all-zero secrets', () => {
    expect(parseAtRestPayload('garbage')).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: SECRET }))).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: 'short' }))).toBeUndefined()
    expect(
      parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(31, 1).toString('base64') })),
    ).toBeUndefined()
    expect(
      parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32, 0).toString('base64') })),
    ).toBeUndefined()
  })
})

describe('at-rest key provider', () => {
  it('caches one source resolution per key id', async () => {
    let calls = 0
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      source: async () => {
        calls += 1
        return PAYLOAD_TEXT
      },
    })
    expect(await provider.protectorKeyFor([KEY_ID])).toEqual(KEY)
    expect(await provider.protectorKeyFor([KEY_ID])).toBe(await provider.protectorKeyFor([KEY_ID]))
    expect(calls).toBe(1)
  })

  it('shares one in-flight resolution between concurrent callers', async () => {
    let calls = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      source: async () => {
        calls += 1
        await gate
        return PAYLOAD_TEXT
      },
    })
    const first = provider.protectorKeyFor([KEY_ID])
    const second = provider.protectorKeyFor([KEY_ID])
    release()
    const [a, b] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(a).toBe(b)
  })

  it('re-resolves once when an envelope names a different key id', async () => {
    const otherSecret = Buffer.alloc(32, 11).toString('base64')
    const otherPayload = JSON.stringify({ version: 1, atRestSecretKey: otherSecret })
    const otherKey = deriveProtectorKey(otherSecret)
    const otherId = createHash('sha256').update(otherKey).digest('hex').slice(0, 16)
    const answers = [PAYLOAD_TEXT, otherPayload, PAYLOAD_TEXT]
    let calls = 0
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      source: async () => {
        calls += 1
        return answers[calls - 1] ?? ''
      },
    })
    expect(await provider.protectorKeyFor([KEY_ID])).toEqual(KEY)
    expect(await provider.protectorKeyFor([otherId])).toEqual(otherKey)
    expect(await provider.protectorKeyFor([KEY_ID])).toEqual(KEY)
    expect(calls).toBe(3)
  })

  it('refuses envelopes sealed by a different installation', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      source: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor(['ffffffffffffffff'])).rejects.toThrow(/does not match/)
  })

  it('reports an unusable payload without echoing its content', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      source: async () => 'not-json-at-all',
    })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/unusable at-rest payload/)
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.not.toThrow(/not-json/)
  })

  it('fails safely when the spawned binary lacks the WorkBuddy binding', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      electronPath: process.execPath,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/WorkBuddy key helper/)
  })

  it('fails safely when the configured binary is missing', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      electronPath: '/nonexistent/workbuddy-electron',
    })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(
      /not available at \/nonexistent\/workbuddy-electron/,
    )
  })

  it('resolves the helper path from env, then the platform default', () => {
    vi.stubEnv(DSH_CONNECT_HUB_WORKBUDDY_ELECTRON_BIN_ENV, '/opt/wb-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBe(
      '/opt/wb-electron',
    )
    vi.stubEnv(DSH_CONNECT_HUB_WORKBUDDY_ELECTRON_BIN_ENV, '   ')
    const cn = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
    })
    if (process.platform === 'darwin') {
      expect(cn.helperPath()).toBe('/Applications/WorkBuddy.app/Contents/MacOS/Electron')
    } else if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA?.trim()
      expect(cn.helperPath()).toBe(
        localAppData === undefined || localAppData === ''
          ? undefined
          : join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      )
    } else {
      expect(cn.helperPath()).toBeUndefined()
    }
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBeUndefined()
  })

  it('reads only the hub-prefixed electron override and ignores the old name', () => {
    vi.stubEnv('WORKBUDDY_ELECTRON_BIN', '/opt/old-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBeUndefined()
    vi.stubEnv(DSH_CONNECT_HUB_WORKBUDDY_ELECTRON_BIN_ENV, '/opt/hub-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBe(
      '/opt/hub-electron',
    )
    vi.unstubAllEnvs()
    vi.stubEnv('WORKBUDDY_AI_ELECTRON_BIN', '/opt/old-ai-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath()).toBeUndefined()
    vi.stubEnv(electronProfileFor(AI_VARIANT).envVar, '/opt/hub-ai-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath()).toBe(
      '/opt/hub-ai-electron',
    )
  })

  it('keeps externally assembled variants source-compatible', () => {
    const externalAi = { id: AI_VARIANT.id } as unknown as WorkBuddyVariant
    const externalCustom = { id: 'workbuddy-custom' } as unknown as WorkBuddyVariant
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(externalAi) }).helperPath()).toBe(
      new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath(),
    )
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(externalCustom) }).helperPath()).toBe(
      new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath(),
    )
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(undefined) }).helperPath()).toBe(
      new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath(),
    )
  })

  it('separates the env variables per product', () => {
    vi.stubEnv(electronProfileFor(AI_VARIANT).envVar, '/opt/ai-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath()).toBe(
      '/opt/ai-electron',
    )
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBeUndefined()
    vi.unstubAllEnvs()
    vi.stubEnv(DSH_CONNECT_HUB_WORKBUDDY_ELECTRON_BIN_ENV, '/opt/cn-electron')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT) }).helperPath()).toBe(
      '/opt/cn-electron',
    )
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath()).toBeUndefined()
    vi.stubEnv(electronProfileFor(AI_VARIANT).envVar, '')
    expect(new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(AI_VARIANT) }).helperPath()).toBeUndefined()
  })

  it('never reaches the network or the real app: the discovery tools are injected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-discovery-'))
    CLEANUPS.push(async () => {
      await rm(root, { recursive: true, force: true })
    })
    let findAppsCalls = 0
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'macos-workbuddy',
      defaultElectronPath: '/nonexistent/wb-app',
      tools: {
        findApps: async () => {
          findAppsCalls += 1
          return [join(root, 'WorkBuddy.app')]
        },
        bundleIdentifier: async () => electronProfileFor(CN_VARIANT).macOS.bundleId,
        bundleVersion: async () => '5.6.2',
      },
    })
    // No executable app on disk: the search completes and reports absence.
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/no WorkBuddy application was found/)
    expect(findAppsCalls).toBe(1)
  })
})
