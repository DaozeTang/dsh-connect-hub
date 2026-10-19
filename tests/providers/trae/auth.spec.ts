import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeTraeCredential,
  parseTraeOwnDocument,
  serializeTraeOwnDocument,
  traeAccountId,
  TraeCredentialStore,
  VaultTraeCredentialPersistence,
  type TraeCredential,
} from '../../../src/providers/trae/auth.ts'
import { TRAE_AUTH_STORAGE_KEY } from '../../../src/providers/trae/decrypt.ts'
import { MemoryTraeCredentialPersistence, MemoryVault } from './helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trae-store-'))
  cleanup.push(dir)
  return dir
}

function storage(token: string, expiresAt: number, userId = 'uid', host = 'https://api.trae.cn'): string {
  return JSON.stringify({
    [TRAE_AUTH_STORAGE_KEY]: JSON.stringify({
      token,
      refreshToken: 'rt',
      userId,
      account: { username: userId },
      host,
      expiredAt: new Date(expiresAt).toISOString(),
      refreshExpiredAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  })
}

describe('credential normalization', () => {
  it('normalizes ISO and numeric expiries while exposing only the display username', () => {
    expect(normalizeTraeCredential({
      token: 'at',
      expiredAt: '2030-01-01T00:00:00.000Z',
      account: { username: 'LaoDing', email: 'private@example.com' },
    }, 'cn', 'desktop')).toMatchObject({
      accessToken: 'at',
      accountName: 'LaoDing',
      edition: 'cn',
      source: 'desktop',
      expiresAtMs: Date.parse('2030-01-01T00:00:00.000Z'),
    })
    expect(normalizeTraeCredential({}, 'cn', 'desktop')).toBeUndefined()
  })

  it('derives a stable account id from edition plus identity', () => {
    const a = traeAccountId({ edition: 'cn', userId: 'u1', accountName: 'A' })
    const b = traeAccountId({ edition: 'cn', userId: 'u1', accountName: 'A' })
    const c = traeAccountId({ edition: 'cn', userId: 'u2', accountName: 'A' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{24}$/)
  })
})

describe('plugin-owned document parsing', () => {
  it('reads the version-2 array and the superseded version-1 single layout', () => {
    const credential: TraeCredential = {
      accessToken: 'tok',
      refreshToken: 'rt',
      userId: 'u',
      host: 'https://api.trae.cn',
      expiresAtMs: Date.now() + 1000,
      edition: 'cn',
      source: 'dsh',
    }
    expect(parseTraeOwnDocument(serializeTraeOwnDocument([credential]))).toHaveLength(1)
    expect(parseTraeOwnDocument({ version: 1, credential })).toHaveLength(1)
    expect(parseTraeOwnDocument({ version: 2, credentials: [{ nonsense: true }, credential] })).toHaveLength(1)
    expect(parseTraeOwnDocument(undefined)).toEqual([])
    expect(parseTraeOwnDocument({ version: 99 })).toEqual([])
  })
})

describe('TraeCredentialStore', () => {
  it('reads desktop storage without modifying it and serves the freshest copy', async () => {
    const dir = await temp()
    const file = join(dir, 'storage.json')
    const before = storage('desktop-token', Date.now() + 3_600_000)
    await writeFile(file, before)
    const persistence = new MemoryTraeCredentialPersistence([
      {
        accessToken: 'refreshed-token',
        refreshToken: 'rt',
        userId: 'uid',
        host: 'https://api.trae.cn',
        expiresAtMs: Date.now() + 86_400_000,
        edition: 'cn',
        source: 'dsh',
      },
    ])
    const store = new TraeCredentialStore({
      storagePath: file,
      edition: 'cn',
      persist: persistence,
      refresh: async () => { throw new Error('unused') },
    })
    await expect(store.current()).resolves.toMatchObject({ accessToken: 'refreshed-token', source: 'dsh' })
    expect(await readFile(file, 'utf8')).toBe(before)
    await expect(store.accounts()).resolves.toHaveLength(1)
  })

  it('single-flights a token refresh and persists the result through the injected store', async () => {
    const dir = await temp()
    const file = join(dir, 'storage.json')
    await writeFile(file, storage('old', Date.now() - 1000))
    let refreshes = 0
    const persistence = new MemoryTraeCredentialPersistence()
    const store = new TraeCredentialStore({
      storagePath: file,
      edition: 'cn',
      persist: persistence,
      refresh: async () => {
        refreshes += 1
        await new Promise(resolve => setTimeout(resolve, 10))
        return { accessToken: 'fresh', refreshToken: 'rt2', expiresAtMs: Date.now() + 3_600_000 }
      },
    })
    const [first, second] = await Promise.all([store.resolve(), store.resolve()])
    expect(first.accessToken).toBe('fresh')
    expect(second.accessToken).toBe('fresh')
    expect(refreshes).toBe(1)
    expect((await persistence.read())[0]?.accessToken).toBe('fresh')
  })

  it('selects by account id across discovered editions and never falls back silently', async () => {
    const dir = await temp()
    const cn = join(dir, 'cn.json')
    const solo = join(dir, 'solo.json')
    await writeFile(cn, storage('cn-token', Date.now() + 3_600_000, 'cn-user'))
    await writeFile(solo, storage('solo-token', Date.now() + 3_600_000, 'solo-user'))
    const store = new TraeCredentialStore({
      persist: new MemoryTraeCredentialPersistence(),
      refresh: async credential => ({ accessToken: credential.accessToken, expiresAtMs: credential.expiresAtMs }),
    })
    store.candidates = () => [
      { edition: 'cn', path: cn, source: 'desktop' },
      { edition: 'solo', path: solo, source: 'desktop' },
    ]
    const accounts = await store.accounts()
    expect(accounts.map(account => account.accountName)).toEqual(['cn-user', 'solo-user'])
    store.selectAccount(accounts[1]!.id)
    await expect(store.resolve()).resolves.toMatchObject({ userId: 'solo-user' })
    store.selectAccount('missing-account')
    await expect(store.current()).resolves.toBeUndefined()
  })

  it('keeps imported accounts when a different account is refreshed later', async () => {
    const dir = await temp()
    const persistence = new MemoryTraeCredentialPersistence()
    const store = new TraeCredentialStore({
      persist: persistence,
      refresh: async () => ({ accessToken: 'refreshed', refreshToken: 'rt2', expiresAtMs: Date.now() + 3_600_000 }),
    })
    const base = {
      refreshToken: 'rt',
      host: 'https://api.trae.cn',
      userRegion: 'CN',
      expiresAtMs: Date.now() + 86_400_000,
      edition: 'cn' as const,
    }
    await store.importAccounts([{ ...base, accessToken: 'imported', userId: 'imp', accountName: 'Imported' }])
    expect(await persistence.read()).toHaveLength(1)
    const file = join(dir, 'storage.json')
    await writeFile(file, storage('desktop-old', Date.now() - 1000, 'desk'))
    const second = new TraeCredentialStore({
      storagePath: file,
      edition: 'cn',
      persist: persistence,
      refresh: async () => ({ accessToken: 'refreshed', refreshToken: 'rt2', expiresAtMs: Date.now() + 3_600_000 }),
    })
    const desktop = (await second.accounts()).find(account => account.source === 'desktop')
    second.selectAccount(desktop!.id)
    await second.resolve()
    const stored = await persistence.read()
    expect(stored.map(item => item.userId).sort()).toEqual(['desk', 'imp'])
    // The imported row keeps its provenance across another account's refresh.
    expect(stored.find(item => item.userId === 'imp')?.imported).toBe(true)
    expect(stored.find(item => item.userId === 'desk')?.imported).toBeUndefined()
  })

  it('reports why each candidate failed without exposing token material', async () => {
    const dir = await temp()
    const invalid = join(dir, 'broken.json')
    await writeFile(invalid, '{"not":"trae"}')
    const store = new TraeCredentialStore({
      persist: new MemoryTraeCredentialPersistence(),
      refresh: async () => { throw new Error('unused') },
    })
    store.candidates = () => [
      { edition: 'cn', path: join(dir, 'missing.json'), source: 'desktop' },
      { edition: 'cn', path: invalid, source: 'desktop' },
    ]
    const { failures } = await store.diagnose()
    expect(failures.map(failure => failure.reason)).toEqual(['missing', 'invalid'])
    expect(JSON.stringify(failures)).not.toContain('token')
  })
})

describe('vault persistence', () => {
  it('serializes imports as a version-2 array in the vault slot', async () => {
    const vault = new MemoryVault()
    const persistence = new VaultTraeCredentialPersistence(vault, 'trae-global')
    await persistence.update(current => [...current, {
      accessToken: 'at',
      userId: 'u',
      host: 'https://api.trae.ai',
      expiresAtMs: Date.now() + 1000,
      edition: 'sg',
      source: 'dsh',
    }])
    const payload = vault.peek('trae-global') as { version?: number; credentials?: unknown[] }
    expect(payload.version).toBe(2)
    expect(payload.credentials).toHaveLength(1)
  })

  it('reads back what the provider wrote and ignores an empty slot', async () => {
    const vault = new MemoryVault()
    const persistence = new VaultTraeCredentialPersistence(vault, 'trae-cn')
    expect(await persistence.read()).toEqual([])
    await persistence.write([{
      accessToken: 'vault-token',
      userId: 'u1',
      host: 'https://api.trae.cn',
      expiresAtMs: Date.now() + 60_000,
      edition: 'cn',
      source: 'dsh',
    }])
    expect((await new VaultTraeCredentialPersistence(vault, 'trae-cn').read())
      .map(item => item.accessToken)).toEqual(['vault-token'])
  })
})
