/**
 * Standalone-provider guarantees: the Qoder runtime is first-party code of
 * dsh-connect-hub. It must start from a fresh profile with nothing but the hub
 * vault, never read an earlier plugin's private data directory, and its
 * sources must not carry another plugin's branding or migration code.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQoderProviders } from '../../../src/providers/qoder/index.ts'
import { harness } from './host.ts'

/** Retired installer/plugin naming kept out of the tree; composed so this spec never ships it as a literal. */
const RETIRED_DIR_NAME = ['.dsh', 'qoder', 'connect'].join('-')
const RETIRED_PACKAGE = ['dsh', 'qoder', 'connect'].join('-')

/** Record every `readFile` the runtime performs; the real implementation runs. */
const fsState = vi.hoisted(() => ({ reads: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const recordingReadFile = (async (path: unknown, ...rest: unknown[]) => {
    fsState.reads.push(String(path))
    return await (actual.readFile as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
  }) as typeof actual.readFile
  return { ...actual, readFile: recordingReadFile }
})

const ORIGINAL_HOME = process.env.HOME
let cleanup: string | undefined

afterEach(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  fsState.reads.length = 0
  if (cleanup !== undefined) {
    await rm(cleanup, { recursive: true, force: true })
    cleanup = undefined
  }
})

function prepareProfile(root: string): { profileDir: string, dataDir: string, stateDir: string } {
  const profileDir = join(root, 'profile')
  const dataDir = join(profileDir, '.dsh-connect-hub')
  return { profileDir, dataDir, stateDir: join(dataDir, 'state') }
}

describe('standalone Qoder provider', () => {
  it('starts needs-credential on a fresh profile with an empty vault and reads only the hub data dir plus the configured desktop sign-in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-standalone-'))
    cleanup = root
    const { profileDir, dataDir } = prepareProfile(root)
    await mkdir(dataDir, { recursive: true })
    // Pin the Qoder CLI's own machine-id lookup under the hub data dir for
    // this test, so "every read is inside the hub data dir" is literal.
    process.env.HOME = dataDir
    const hosted = harness(root, profileDir)
    fsState.reads.length = 0

    const runtime = createQoderProviders(hosted.deps)[0]!
    await runtime.init()
    try {
      const status = runtime.status()
      expect(status.state).toBe('needs-credential')
      expect(status.credential).toBeUndefined()
      expect(status.catalog).toMatchObject({ source: 'builtin', models: [] })
      expect(status.checkin).toMatchObject({ state: 'unknown', log: [] })
      expect(status.capabilities).toMatchObject({ usage: false, checkin: false })
      expect(fsState.reads.length).toBeGreaterThan(0)
      for (const path of fsState.reads) {
        // The desktop sign-in probe is the one documented read outside the hub
        // data dir; it is pinned by the env override in the test setup file.
        const desktopCandidate = path === process.env['DSH_CONNECT_HUB_QODER_CN_AUTH_FILE']
          || path === process.env['DSH_CONNECT_HUB_QODER_GLOBAL_AUTH_FILE']
        expect(path.startsWith(dataDir) || desktopCandidate, `unexpected read outside the hub data dir: ${path}`).toBe(true)
      }
      expect(fsState.reads.some(path => path.includes(RETIRED_DIR_NAME))).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('ignores earlier plugin data directories and leaves them untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-standalone-'))
    cleanup = root
    const { profileDir, dataDir } = prepareProfile(root)
    await mkdir(dataDir, { recursive: true })
    const legacyRoot = join(root, RETIRED_DIR_NAME)
    const legacyProfile = join(profileDir, RETIRED_DIR_NAME)
    await mkdir(legacyRoot, { recursive: true })
    await mkdir(legacyProfile, { recursive: true })
    const legacyAuth = join(legacyRoot, '.qoder-auth.json')
    const legacySettings = join(legacyProfile, 'settings.json')
    const legacyCheckin = join(legacyProfile, 'checkin-status.json')
    await writeFile(legacyAuth, JSON.stringify({ version: 2, pat: 'pat-from-legacy-plugin', region: 'china', savedAt: 1 }))
    await writeFile(legacySettings, JSON.stringify({ disabledModelsCN: ['cmodel'], autoCheckInCN: true, checkInMinuteCN: 601 }))
    await writeFile(legacyCheckin, JSON.stringify({ qoder: { lastDate: '2026-10-18', status: 'claimed', amount: 100 } }))
    process.env.HOME = dataDir
    const hosted = harness(root, profileDir)
    fsState.reads.length = 0

    const runtime = createQoderProviders(hosted.deps)[0]!
    await runtime.init()
    try {
      // A valid-looking legacy PAT/settings/check-in must not seed the provider.
      const status = runtime.status()
      expect(status.state).toBe('needs-credential')
      expect(status.catalog.models).toEqual([])
      expect(status.checkin).toMatchObject({ enabled: false, minute: 600 })
      expect(fsState.reads.filter(path => path.includes(RETIRED_DIR_NAME))).toEqual([])
      for (const path of fsState.reads) {
        const desktopCandidate = path === process.env['DSH_CONNECT_HUB_QODER_CN_AUTH_FILE']
          || path === process.env['DSH_CONNECT_HUB_QODER_GLOBAL_AUTH_FILE']
        expect(path.startsWith(dataDir) || desktopCandidate, `unexpected read outside the hub data dir: ${path}`).toBe(true)
      }
    } finally {
      await runtime.dispose()
    }
    // The legacy files are read-only inputs from an earlier install and
    // must never be modified or deleted.
    expect(JSON.parse(await readFile(legacyAuth, 'utf8'))).toMatchObject({ pat: 'pat-from-legacy-plugin' })
    expect(JSON.parse(await readFile(legacySettings, 'utf8'))).toMatchObject({ disabledModelsCN: ['cmodel'] })
    expect(JSON.parse(await readFile(legacyCheckin, 'utf8'))).toMatchObject({ qoder: { status: 'claimed' } })
  })

  it('carries no foreign-plugin branding or migration module in its sources', async () => {
    const providerRoot = join(import.meta.dirname, '../../../src/providers/qoder')
    const files = (await readdir(providerRoot, { recursive: true })) as string[]
    const sources = files.filter(file => file.endsWith('.ts'))
    expect(sources).not.toContain('legacy.ts')
    for (const file of sources) {
      const text = await readFile(join(providerRoot, file), 'utf8')
      expect(text, file).not.toContain(RETIRED_PACKAGE)
      expect(text, file).not.toContain(['dsh', 'provider', 'qoder'].join('-'))
      expect(text, file).not.toContain('legacyAuthFilename')
      expect(text, file).not.toContain('legacy-prefs')
    }
  })
})
