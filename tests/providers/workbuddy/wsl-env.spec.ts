import { execFile } from 'node:child_process'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  helperChildEnv,
  WorkBuddyAtRestKeyProvider,
  wslenvForwardRunAsNode,
} from '../../../src/providers/workbuddy/desktop-credential-protection.ts'
import { CN_VARIANT, electronProfileFor } from '../../../src/providers/workbuddy/variants.ts'

/**
 * From WSL, the at-rest key helper spawns the Windows WorkBuddy exe through
 * interop. A child env of `{ ...process.env, ELECTRON_RUN_AS_NODE: '1' }` is not
 * enough there: WSL forwards a variable to the Windows side only when `WSLENV`
 * lists it with the `/w` direction flag. Without it the exe starts in GUI mode
 * and its stdout is app log, so the plugin reported an unreadable credential for
 * a signed-in account.
 *
 * Everything here is offline: `node:child_process` is mocked so no Windows
 * binary is ever launched and no real credential is read.
 */

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const execFileMock = execFile as unknown as Mock

interface CapturedSpawn {
  path: string
  options: { env: Record<string, string | undefined>, timeout: number, maxBuffer: number }
  callback: (error: { killed?: boolean, code?: number | string } | null, stdout: string) => void
}

describe('WSLENV merge (wslenvForwardRunAsNode)', () => {
  it('appends the flagged entry when WSLENV is unset or empty', () => {
    expect(wslenvForwardRunAsNode(undefined)).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('')).toBe('ELECTRON_RUN_AS_NODE/w')
  })

  it('keeps other entries and drops the trailing empty segment Windows Terminal leaves', () => {
    expect(wslenvForwardRunAsNode('WT_SESSION:WT_PROFILE_ID:')).toBe(
      'WT_SESSION:WT_PROFILE_ID:ELECTRON_RUN_AS_NODE/w',
    )
  })

  it('drops inner empty segments', () => {
    expect(wslenvForwardRunAsNode('A::B')).toBe('A:B:ELECTRON_RUN_AS_NODE/w')
  })

  it('treats a bare entry as carrying no direction and consolidates to /w', () => {
    expect(wslenvForwardRunAsNode('FOO:ELECTRON_RUN_AS_NODE')).toBe('FOO:ELECTRON_RUN_AS_NODE/w')
  })

  it('keeps the user /u direction by consolidating to /uw', () => {
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/u')).toBe('ELECTRON_RUN_AS_NODE/uw')
  })

  it('normalizes path flags away — the value is the numeric switch 1, never a path', () => {
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/p')).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/l')).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/pu')).toBe('ELECTRON_RUN_AS_NODE/uw')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/pw')).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/lw')).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/plw')).toBe('ELECTRON_RUN_AS_NODE/w')
  })

  it('leaves an already-safe entry byte-identical (idempotence)', () => {
    expect(wslenvForwardRunAsNode('FOO:ELECTRON_RUN_AS_NODE/w')).toBe('FOO:ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('FOO:ELECTRON_RUN_AS_NODE/uw')).toBe('FOO:ELECTRON_RUN_AS_NODE/uw')
  })

  it('collapses duplicate same-name entries into one effective entry', () => {
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/u:ELECTRON_RUN_AS_NODE/w')).toBe('ELECTRON_RUN_AS_NODE/uw')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/w:ELECTRON_RUN_AS_NODE/u')).toBe('ELECTRON_RUN_AS_NODE/uw')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE:ELECTRON_RUN_AS_NODE/l:ELECTRON_RUN_AS_NODE/pu')).toBe(
      'ELECTRON_RUN_AS_NODE/uw',
    )
    expect(wslenvForwardRunAsNode('FOO:ELECTRON_RUN_AS_NODE:ELECTRON_RUN_AS_NODE')).toBe('FOO:ELECTRON_RUN_AS_NODE/w')
  })

  it('consolidates at the first same-name position; other entries keep their places', () => {
    expect(wslenvForwardRunAsNode('A:ELECTRON_RUN_AS_NODE/l:B:ELECTRON_RUN_AS_NODE/u:C')).toBe(
      'A:ELECTRON_RUN_AS_NODE/uw:B:C',
    )
  })

  it('is idempotent as a whole: merging twice changes nothing more', () => {
    for (const input of [
      'WT_SESSION:WT_PROFILE_ID:',
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_RUN_AS_NODE/u',
      'ELECTRON_RUN_AS_NODE/pw',
      'ELECTRON_RUN_AS_NODE/u:ELECTRON_RUN_AS_NODE/w',
      'A:ELECTRON_RUN_AS_NODE/l:B:ELECTRON_RUN_AS_NODE/u:C',
    ]) {
      const once = wslenvForwardRunAsNode(input)
      expect(wslenvForwardRunAsNode(once)).toBe(once)
    }
  })
})

describe('helper child environment', () => {
  it('passes only the documented basics and never the parent’s secrets', () => {
    const parent = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/alice',
      USERPROFILE: 'C:\\Users\\alice',
      TMPDIR: '/tmp',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      SystemRoot: 'C:\\Windows',
      // Anything not on the allow-list must stay with the parent.
      DSH_TEST_MARKER_SECRET: 'do-not-inherit-this',
      AWS_SECRET_ACCESS_KEY: 'also-not-for-the-helper',
      OPENAI_API_KEY: 'nor-this',
      'npm_config_//registry': 'https://user:token@registry.example',
    } as NodeJS.ProcessEnv
    const child = helperChildEnv(parent, '/Applications/WorkBuddy.app/Contents/MacOS/Electron', false)
    expect(child['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(child['PATH']).toBe('/usr/bin:/bin')
    expect(child['HOME']).toBe('/Users/alice')
    expect(child['USERPROFILE']).toBe('C:\\Users\\alice')
    expect(child['TMPDIR']).toBe('/tmp')
    expect(child['TEMP']).toBe('C:\\Temp')
    expect(child['LANG']).toBe('zh_CN.UTF-8')
    expect(child['LC_ALL']).toBe('zh_CN.UTF-8')
    expect(child['DSH_TEST_MARKER_SECRET']).toBeUndefined()
    expect(child['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    expect(child['OPENAI_API_KEY']).toBeUndefined()
    expect(child['npm_config_//registry']).toBeUndefined()
    // The parent object itself is untouched.
    expect(parent['DSH_TEST_MARKER_SECRET']).toBe('do-not-inherit-this')
    expect(parent['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })

  it('forces ELECTRON_RUN_AS_NODE for the helper and never mutates the parent', () => {
    const parent = { HOME: '/home/u', WSLENV: 'WT_SESSION:WT_PROFILE_ID:' }
    const child = helperChildEnv(parent, '/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', true)
    expect(child['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(child['WSLENV']).toBe('WT_SESSION:WT_PROFILE_ID:ELECTRON_RUN_AS_NODE/w')
    expect(parent['WSLENV']).toBe('WT_SESSION:WT_PROFILE_ID:')
  })

  it('merges for a Windows exe under a custom WSL automount root', () => {
    for (const path of [
      '/windir/c/Program Files/WorkBuddy/WorkBuddy.exe',
      '/c/Program Files/WorkBuddy/WorkBuddy.exe',
    ]) {
      const child = helperChildEnv({ WSLENV: 'WT_SESSION:' }, path, true)
      expect(child['WSLENV']).toBe('WT_SESSION:ELECTRON_RUN_AS_NODE/w')
    }
  })

  it('matches the .exe suffix case-insensitively', () => {
    const child = helperChildEnv({ WSLENV: 'WT_SESSION:' }, '/windir/c/Program Files/WorkBuddy/WorkBuddy.EXE', true)
    expect(child['WSLENV']).toBe('WT_SESSION:ELECTRON_RUN_AS_NODE/w')
  })

  it('leaves WSLENV alone for a native Linux helper — even under /mnt', () => {
    for (const path of ['/opt/wb-electron', '/mnt/tools/wb-electron']) {
      const child = helperChildEnv({ HOME: '/home/u' }, path, true)
      expect(child['WSLENV']).toBeUndefined()
      expect(child['ELECTRON_RUN_AS_NODE']).toBe('1')
    }
  })
})

describe('helper spawn wiring', () => {
  let spawns: CapturedSpawn[] = []
  let answer: (spawn: CapturedSpawn) => void = () => {}

  beforeEach(() => {
    spawns = []
    answer = () => {}
    execFileMock.mockReset().mockImplementation(
      (
        path: string,
        _args: unknown[],
        options: CapturedSpawn['options'],
        callback: CapturedSpawn['callback'],
      ) => {
        const spawn = { path, options, callback }
        spawns.push(spawn)
        answer(spawn)
      },
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /** A provider whose private spawn path is reachable without spawning anything real. */
  function spawnAt(path: string, wsl: () => boolean): Promise<string> {
    const provider = new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), wsl })
    return (provider as unknown as { spawnAt(electronPath: string): Promise<string> }).spawnAt(path)
  }

  it('spawns the helper with a minimized env: no parent secret reaches execFile', async () => {
    vi.stubEnv('DSH_TEST_MARKER_SECRET', 'do-not-inherit-this')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'also-not-for-the-helper')
    answer = (spawn) => spawn.callback(null, '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => false)).rejects.toThrow(
      /produced no payload/,
    )
    const env = spawns[0]!.options.env
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(env['DSH_TEST_MARKER_SECRET']).toBeUndefined()
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    // The spawn is shell-free and bounded (unchanged properties restated here
    // so the hardening test fails if either is ever regressed).
    expect(spawns[0]!.options.timeout).toBeGreaterThan(0)
    expect(spawns[0]!.options.maxBuffer).toBeGreaterThan(0)
  })

  it('passes the previous env through on a non-WSL host, even for a /mnt-style exe path', async () => {
    answer = (spawn) => spawn.callback(null, '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => false)).rejects.toThrow(
      /produced no payload/,
    )
    const env = spawns[0]!.options.env
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(env['WSLENV']).toBe(process.env['WSLENV'])
  })

  it('forwards ELECTRON_RUN_AS_NODE through WSLENV for a WSL to Windows exe spawn', async () => {
    answer = (spawn) => spawn.callback(null, '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => true)).rejects.toThrow(
      /produced no payload/,
    )
    const env = spawns[0]!.options.env
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(env['WSLENV']).toBe(wslenvForwardRunAsNode(process.env['WSLENV']))
    expect(env['WSLENV']).toContain('ELECTRON_RUN_AS_NODE/w')
    expect(process.env['WSLENV']).toBeUndefined()
  })

  it('normalizes an inherited WSLENV with a trailing colon, without touching the parent', async () => {
    vi.stubEnv('WSLENV', 'WT_SESSION:WT_PROFILE_ID:')
    answer = (spawn) => spawn.callback(null, '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => true)).rejects.toThrow(
      /produced no payload/,
    )
    expect(spawns[0]!.options.env['WSLENV']).toBe('WT_SESSION:WT_PROFILE_ID:ELECTRON_RUN_AS_NODE/w')
    expect(process.env['WSLENV']).toBe('WT_SESSION:WT_PROFILE_ID:')
  })

  it('consolidates duplicate same-name entries the user may carry', async () => {
    vi.stubEnv('WSLENV', 'ELECTRON_RUN_AS_NODE/u:ELECTRON_RUN_AS_NODE/w')
    answer = (spawn) => spawn.callback(null, '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => true)).rejects.toThrow(
      /produced no payload/,
    )
    expect(spawns[0]!.options.env['WSLENV']).toBe('ELECTRON_RUN_AS_NODE/uw')
    expect(process.env['WSLENV']).toBe('ELECTRON_RUN_AS_NODE/u:ELECTRON_RUN_AS_NODE/w')
  })

  it('attributes a non-zero exit to the helper, code only', async () => {
    answer = (spawn) => spawn.callback(Object.assign(new Error('failed'), { code: 3 }), '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => true)).rejects.toThrow(
      /WorkBuddy key helper \(.+\) exited with code 3/,
    )
  })

  it('attributes GUI-mode log output to the payload-format branch, not the empty branch', async () => {
    answer = (spawn) => spawn.callback(null, '[AccountService] HTTP interceptor registered')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      electronPath: process.execPath,
      wsl: () => false,
    })
    await expect(provider.protectorKeyFor(['aaaaaaaaaaaaaaaa'])).rejects.toThrow(/unusable at-rest payload/)
    await expect(provider.protectorKeyFor(['aaaaaaaaaaaaaaaa'])).rejects.not.toThrow(/AccountService/)
  })
})
