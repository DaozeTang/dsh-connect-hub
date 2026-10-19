import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FALLBACK_APP_VERSION,
  FALLBACK_CN_APP_VERSION,
  VersionCache,
  appUserAgent,
  readBundleVersion,
  resolveAppVersion,
  validAppVersion,
} from '../../../src/providers/workbuddy/app-version.ts'
import {
  chatUserAgent,
  fallbackChatIdentity,
  readCliVersion,
  validCliVersion,
} from '../../../src/providers/workbuddy/client-identity.ts'
import { parseWindowsDisplayIcon, parseWindowsRegistryOutput } from '../../../src/providers/workbuddy/desktop-credential-protection.ts'
import { CN_VARIANT, electronProfileFor } from '../../../src/providers/workbuddy/variants.ts'
import { FakePrefs } from './helpers.ts'

const CLEANUPS: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUPS.splice(0).map((cleanup) => cleanup()))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  CLEANUPS.push(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('version parsing', () => {
  it('accepts dotted versions only', () => {
    for (const value of ['5.5.2', '5.6.2.1', '12.0.0']) expect(validAppVersion(value)).toBe(true)
    for (const value of ['', '5', '5.5.2-rc', ' 5.5.2', '5.5.2\n', 'v5.5.2', '5.5.5.5.5', 5]) {
      expect(validAppVersion(value)).toBe(false)
    }
  })

  it('tolerates a prerelease suffix for CLI versions only', () => {
    expect(validCliVersion('2.137.1-rc.1')).toBe(true)
    expect(validCliVersion('2.137.1')).toBe(true)
    expect(validCliVersion('2.137.1 rc')).toBe(false)
    expect(validCliVersion('2.137.1\n')).toBe(false)
  })

  it('builds the region-specific user agents and rejects bad versions', () => {
    expect(chatUserAgent({ clientVersion: '5.6.2', cliVersion: '2.63.2' }, 'cn')).toBe(
      'WorkBuddy/5.6.2 WorkBuddy/5.6.2 CLI/2.63.2',
    )
    expect(chatUserAgent({ clientVersion: '5.6.2' }, 'global')).toBe(
      'WorkBuddy/5.6.2 WorkBuddy AI/5.6.2',
    )
    expect(() => chatUserAgent({ clientVersion: 'bad version' }, 'cn')).toThrow(/invalid client version/)
    expect(appUserAgent('5.5.2')).toBe('WorkBuddyAI/5.5.2')
    expect(() => appUserAgent('5.5.2 bad')).toThrow(/invalid WorkBuddy AI version/)
  })

  it('falls back per region', () => {
    expect(fallbackChatIdentity('cn')).toEqual({ clientVersion: FALLBACK_CN_APP_VERSION })
    expect(fallbackChatIdentity('global')).toEqual({ clientVersion: FALLBACK_APP_VERSION })
  })
})

describe('bundle metadata reading', () => {
  it('reads CFBundleShortVersionString from an XML plist and ignores other strings', async () => {
    const dir = await tempDir('wb-plist-')
    const plist = join(dir, 'Info.plist')
    await writeFile(
      plist,
      `<?xml version="1.0"?><plist><dict>
        <key>CFBundleName</key><string>WorkBuddy AI</string>
        <key>CFBundleShortVersionString</key><string>5.6.2</string>
      </dict></plist>`,
    )
    expect(await readBundleVersion(plist)).toBe('5.6.2')
    expect(await readBundleVersion(join(dir, 'missing.plist'))).toBeUndefined()
  })

  it('reads the bundled CLI version from publishConfig.customPackage', async () => {
    const dir = await tempDir('wb-cli-')
    const cliDir = join(dir, 'Contents', 'Resources', 'app.asar.unpacked', 'cli')
    await mkdir(cliDir, { recursive: true })
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({ version: '0.0.0' }))
    expect(await readCliVersion(dir)).toBeUndefined()
    await writeFile(
      join(cliDir, 'package.json'),
      JSON.stringify({ version: '0.0.0', publishConfig: { customPackage: { version: '2.137.1-rc.1' } } }),
    )
    expect(await readCliVersion(dir)).toBe('2.137.1-rc.1')
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({ version: '2.63.2' }))
    expect(await readCliVersion(dir)).toBe('2.63.2')
  })
})

describe('resolveAppVersion', () => {
  it('prefers the installed app and remembers it', async () => {
    const prefs = new FakePrefs()
    const cache = new VersionCache(prefs, 'provider:workbuddy-ai:version')
    await cache.load()
    const resolved = await resolveAppVersion({
      cache,
      installed: async () => ({ version: '5.7.0', bundle: '/Applications/WorkBuddy AI.app' }),
    })
    expect(resolved).toEqual({ version: '5.7.0', source: 'installed', bundle: '/Applications/WorkBuddy AI.app' })
    expect(cache.get()).toBe('5.7.0')
    const persisted = await new VersionCache(prefs, 'provider:workbuddy-ai:version').load()
    void persisted
    expect(prefs.values.get('provider:workbuddy-ai:version')).toMatchObject({ version: '5.7.0' })
  })

  it('falls back to the saved value, then to the compiled-in constant', async () => {
    const prefs = new FakePrefs()
    const cache = new VersionCache(prefs, 'version')
    await cache.load()
    expect((await resolveAppVersion({ cache, installed: async () => undefined })).source).toBe('fallback')
    await cache.remember('5.6.2')
    expect(await resolveAppVersion({ cache, installed: async () => undefined })).toEqual({
      version: '5.6.2',
      source: 'saved',
    })
    expect((await resolveAppVersion({ installed: async () => undefined })).version).toBe(FALLBACK_APP_VERSION)
  })

  it('ignores malformed cached values', async () => {
    const prefs = new FakePrefs()
    prefs.values.set('version', { version: 'not-a-version' })
    const cache = new VersionCache(prefs, 'version')
    await cache.load()
    expect(cache.get()).toBeUndefined()
  })
})

describe('Windows registry parsing', () => {
  const pattern = electronProfileFor(CN_VARIANT).windows.displayNamePattern

  it('extracts DisplayIcon candidates for matching product entries only', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddy',
      '    DisplayName    REG_SZ    WorkBuddy 5.6.2',
      '    DisplayIcon    REG_SZ    "C:\\Users\\alice\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe",0',
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OtherApp',
      '    DisplayName    REG_SZ    Some Other App',
      '    DisplayIcon    REG_SZ    C:\\Other\\other.exe',
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddyAINotMatched',
      '    DisplayName    REG_SZ    WorkBuddy AI 5.6.2',
      '    DisplayIcon    REG_SZ    C:\\AI\\workbuddyai.exe',
    ].join('\r\n')
    const parsed = parseWindowsRegistryOutput(output, pattern)
    expect(parsed.candidates).toEqual(['C:\\Users\\alice\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe'])
    expect(parsed.incomplete).toBe(false)
  })

  it('marks a matching entry without a usable DisplayIcon as incomplete, never as absent', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddy',
      '    DisplayName    REG_SZ    WorkBuddy 5.6.2',
      '    DisplayIcon    REG_SZ    not-an-exe',
    ].join('\r\n')
    expect(parseWindowsRegistryOutput(output, pattern)).toEqual({ candidates: [], incomplete: true })
  })

  it('parses quoted and unquoted DisplayIcon values, stripping icon indexes', () => {
    expect(parseWindowsDisplayIcon('"C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",0')).toBe(
      'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    )
    expect(parseWindowsDisplayIcon('C:\\Program Files\\WorkBuddy\\WorkBuddy.exe')).toBe(
      'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    )
    expect(parseWindowsDisplayIcon('C:\\Program Files\\WorkBuddy\\WorkBuddy.exe,3')).toBe(
      'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    )
    expect(parseWindowsDisplayIcon('C:\\NotAnExe\\thing.dll')).toBeUndefined()
    expect(parseWindowsDisplayIcon('"unterminated')).toBeUndefined()
  })
})
