import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyCredentialStore,
  createDefaultKeyProvider,
  defaultDesktopAuthCandidates,
  desktopAuthCandidatesFor,
  parseOwnDocument,
  parseWorkBuddyAuth,
  windowsPathForWsl,
  type WorkBuddyCredential,
} from '../../../src/providers/workbuddy/auth.ts'
import { AI_VARIANT, CN_VARIANT } from '../../../src/providers/workbuddy/variants.ts'
import { FakeVault } from './helpers.ts'

const CLEANUPS: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUPS.splice(0).map((cleanup) => cleanup()))
  vi.unstubAllEnvs()
})

function nestedDoc(expiresAt: number): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1', enterpriseId: 'ent-1', nickname: '昵称' },
  })
}

function credentialWith(expiresAtMs: number): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    source: 'desktop',
  }
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  CLEANUPS.push(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('parseWorkBuddyAuth', () => {
  it('reads the desktop nested form with millisecond expiry', () => {
    const credential = parseWorkBuddyAuth(nestedDoc(1_792_128_236_868))
    expect(credential?.accessToken).toBe('at')
    expect(credential?.refreshToken).toBe('rt')
    expect(credential?.expiresAtMs).toBe(1_792_128_236_868)
    expect(credential?.uid).toBe('uid-1')
    expect(credential?.enterpriseId).toBe('ent-1')
    expect(credential?.nickname).toBe('昵称')
    expect(credential?.source).toBe('desktop')
  })

  it('normalizes second-precision expiry to milliseconds', () => {
    expect(parseWorkBuddyAuth(nestedDoc(1_792_128_236))?.expiresAtMs).toBe(1_792_128_236_000)
  })

  it('reads the flat panel form', () => {
    const credential = parseWorkBuddyAuth(
      JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: 0, domain: '', uid: 'uid-2' }),
    )
    expect(credential?.accessToken).toBe('at')
    expect(credential?.uid).toBe('uid-2')
    expect(credential?.expiresAtMs).toBe(0)
  })

  it('rejects documents without an access token', () => {
    expect(parseWorkBuddyAuth('{}')).toBeUndefined()
    expect(parseWorkBuddyAuth('not json')).toBeUndefined()
    expect(parseWorkBuddyAuth(JSON.stringify({ auth: { refreshToken: 'rt' } }))).toBeUndefined()
  })
})

describe('parseOwnDocument', () => {
  it('reads the plugin-owned payload and rejects other formats', () => {
    const credential = credentialWith(123)
    expect(
      parseOwnDocument({ version: 1, savedAtMs: 1, credential: { ...credential, source: 'dsh' } }),
    ).toMatchObject({ accessToken: 'at', uid: 'uid-1', source: 'dsh' })
    expect(parseOwnDocument(undefined)).toBeUndefined()
    expect(parseOwnDocument({ version: 2, credential })).toBeUndefined()
    expect(parseOwnDocument({ version: 1, credential: {} })).toBeUndefined()
  })
})

describe('default at-rest key provider', () => {
  it('enables app discovery so an encrypted desktop sign-in can be opened', () => {
    const provider = createDefaultKeyProvider(CN_VARIANT)
    if (process.platform === 'darwin') {
      expect(provider.helperPath()).toBe('/Applications/WorkBuddy.app/Contents/MacOS/Electron')
    } else if (process.platform === 'win32') {
      expect(provider.helperPath()?.endsWith('WorkBuddy.exe') ?? false).toBe(
        (process.env.LOCALAPPDATA?.trim() ?? '') !== '',
      )
    } else {
      // No verified layout: an explicit env var is the only way in.
      expect(provider.helperPath()).toBeUndefined()
    }
  })
})

describe('WSL path normalization', () => {
  it('maps Windows drive paths into the /mnt convention', () => {
    expect(windowsPathForWsl('C:\\Users\\alice\\AppData')).toBe('/mnt/c/Users/alice/AppData')
    expect(windowsPathForWsl('D:/Data/App')).toBe('/mnt/d/Data/App')
    expect(windowsPathForWsl('/already/posix')).toBe('/already/posix')
    expect(windowsPathForWsl(undefined)).toBeUndefined()
    expect(windowsPathForWsl('relative/path')).toBeUndefined()
  })

  it('builds per-variant candidates inside the shared auth directory', () => {
    const authDirs = defaultDesktopAuthCandidates()
    expect(authDirs.length).toBeGreaterThan(0)
    for (const variant of [CN_VARIANT, AI_VARIANT]) {
      const candidates = desktopAuthCandidatesFor(variant)
      expect(candidates).toHaveLength(authDirs.length)
      // The app file sits *inside* the auth directory (same folder as the
      // documented layout), never one level above it.
      expect(candidates[0]).toBe(join(authDirs[0]!, variant.desktopFilename))
      for (const candidate of candidates) expect(candidate.endsWith(variant.desktopFilename)).toBe(true)
    }
  })
})

describe('WorkBuddyCredentialStore', () => {
  function makeStore(vault: FakeVault, desktopPath: string, refresh = async (): Promise<{ accessToken: string }> => ({ accessToken: 'new' })): WorkBuddyCredentialStore {
    return new WorkBuddyCredentialStore({
      variant: CN_VARIANT,
      desktopPath,
      vault,
      slot: 'workbuddy-cn',
      refresh,
    })
  }

  it('serves a fresh desktop credential without refreshing', async () => {
    const dir = await tempDir('wb-store-')
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 3_600_000))
    let refreshes = 0
    const store = makeStore(new FakeVault(), desktop, async () => {
      refreshes += 1
      return { accessToken: 'new' }
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at', source: 'desktop' })
    expect(refreshes).toBe(0)
  })

  it('refreshes an expiring credential, persists the vault copy, and serves it next', async () => {
    const dir = await tempDir('wb-store-')
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    const vault = new FakeVault()
    const store = makeStore(vault, desktop, async () => ({ accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600 }))
    const credential = await store.resolve()
    expect(credential).toMatchObject({ accessToken: 'fresh', refreshToken: 'rt2', source: 'dsh' })
    expect(vault.writes).toEqual(['workbuddy-cn'])
    const stored = vault.slots.get('workbuddy-cn') as { version: number, credential: WorkBuddyCredential }
    expect(stored.version).toBe(1)
    expect(stored.credential.accessToken).toBe('fresh')
    // The desktop file is never written.
    expect(await store.current()).toMatchObject({ accessToken: 'fresh', source: 'dsh' })
  })

  it('single-flights overlapping refreshes', async () => {
    const dir = await tempDir('wb-store-')
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    let refreshes = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = makeStore(new FakeVault(), desktop, async () => {
      refreshes += 1
      await gate
      return { accessToken: 'fresh', expiresInSec: 3600 }
    })
    const first = store.resolve()
    await vi.waitFor(() => {
      expect(refreshes).toBe(1)
    })
    const second = store.resolve()
    // Let the second caller finish its credential reads and join the in-flight
    // refresh before the gate opens; a fixed pause keeps the test independent
    // of scheduling under full-suite load.
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(refreshes).toBe(1)
  })

  it('keeps a still-valid token when the refresh endpoint fails', async () => {
    const dir = await tempDir('wb-store-')
    const desktop = join(dir, 'workbuddy-desktop.info')
    // Expired inside the five-minute refresh margin but still valid for a while.
    await writeFile(desktop, nestedDoc(Date.now() + 60_000))
    const store = makeStore(new FakeVault(), desktop, async () => {
      throw new Error('refresh endpoint offline')
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('throws an actionable error when the token is expired and no refresh token exists', async () => {
    const dir = await tempDir('wb-store-')
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(
      desktop,
      JSON.stringify({ auth: { accessToken: 'at', expiresAt: Date.now() - 1000 }, account: { uid: 'u' } }),
    )
    const store = makeStore(new FakeVault(), desktop)
    await expect(store.resolve()).rejects.toThrow(/sign in again in the WorkBuddy desktop app/)
  })

  it('prefers the desktop file when identities differ, regardless of expiry', async () => {
    const dir = await tempDir('wb-store-')
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 1000))
    const vault = new FakeVault()
    vault.slots.set('workbuddy-cn', {
      version: 1,
      savedAtMs: 1,
      credential: {
        accessToken: 'own-at',
        refreshToken: 'own-rt',
        expiresAtMs: Date.now() + 60 * 60 * 1000,
        domain: 'www.codebuddy.cn',
        uid: 'uid-old',
        source: 'dsh',
      },
    })
    const store = makeStore(vault, desktop)
    const credential = await store.current()
    expect(credential?.accessToken).toBe('at')
    expect(credential?.uid).toBe('uid-1')
  })

  it('reports a credential for the other product as a region mismatch', async () => {
    const dir = await tempDir('wb-store-')
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(
      desktop,
      JSON.stringify({
        auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000, domain: 'www.workbuddy.ai' },
        account: { uid: 'uid-9' },
      }),
    )
    const store = makeStore(new FakeVault(), desktop)
    await expect(store.current()).rejects.toThrow(/credential-region-mismatch|received a WorkBuddy AI credential/)
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    expect(status.reason).toContain('WorkBuddy AI')
    expect(status.reasonCode).toBe('credential-region-mismatch')
  })

  it('reports an unreadable desktop file instead of falling back to the vault copy', async () => {
    const dir = await tempDir('wb-store-')
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, '{ not json at all')
    const vault = new FakeVault()
    vault.slots.set('workbuddy-cn', {
      version: 1,
      savedAtMs: 1,
      credential: { ...credentialWith(Date.now() + 60_000), accessToken: 'stale', source: 'dsh' },
    })
    const store = makeStore(vault, desktop)
    await expect(store.resolve()).rejects.toThrow(/exists but is unreadable/)
  })

  it('logout removes only the vault copy', async () => {
    const dir = await tempDir('wb-store-')
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 60_000))
    const vault = new FakeVault()
    vault.slots.set('workbuddy-cn', { version: 1, savedAtMs: 1, credential: credentialWith(1) })
    const store = makeStore(vault, desktop)
    await store.logout()
    expect(vault.slots.has('workbuddy-cn')).toBe(false)
    expect((await store.current())?.source).toBe('desktop')
  })
})

describe('hub-owned env overrides', () => {
  it('reads the hub-prefixed auth-file variable and ignores the old unprefixed names', async () => {
    vi.stubEnv('DSH_CONNECT_HUB_WORKBUDDY_AUTH_FILE', '/tmp/hub-cn-auth.info')
    vi.stubEnv('WORKBUDDY_AUTH_FILE', '/tmp/old-cn-auth.info')
    const store = new WorkBuddyCredentialStore({
      variant: CN_VARIANT,
      vault: new FakeVault(),
      slot: 'workbuddy-cn',
      refresh: async () => ({ accessToken: 'unused' }),
    })
    expect(store.desktopAuthPath()).toBe('/tmp/hub-cn-auth.info')
    expect(store.desktopAuthPath()).not.toBe('/tmp/old-cn-auth.info')
  })

  it('uses the product-specific hub variable for the international route', async () => {
    vi.stubEnv('DSH_CONNECT_HUB_WORKBUDDY_AI_AUTH_FILE', '/tmp/hub-ai-auth.info')
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', '/tmp/old-ai-auth.info')
    const store = new WorkBuddyCredentialStore({
      variant: AI_VARIANT,
      vault: new FakeVault(),
      slot: 'workbuddy-ai',
      refresh: async () => ({ accessToken: 'unused' }),
    })
    expect(store.desktopAuthPath()).toBe('/tmp/hub-ai-auth.info')
  })
})
