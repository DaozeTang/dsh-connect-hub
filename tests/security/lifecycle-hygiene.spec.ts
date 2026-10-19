/**
 * Lifecycle robustness and open-source hygiene checks.
 *
 * Lifecycle: timers/registrations must survive double dispose and never leak an
 * unhandled rejection into the host process. Hygiene: no personal paths, no
 * external assets, no XSS sinks.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Scheduler, SingleFlight } from '../../src/core/scheduler.ts'
import { PrefsStore } from '../../src/core/prefs.ts'
import { Vault } from '../../src/core/vault.ts'
import type { HubPaths } from '../../src/core/paths.ts'
import type { Context } from '@deepseek-ai/cordis'
import { ClientPreferencesStore, CLIENT_PREFERENCES_STORAGE_KEY } from '../../src/client/prefs.ts'
import type { PreferenceStorage } from '../../src/client/prefs.ts'
import { createQoderProviders } from '../../src/providers/qoder/index.ts'
import { harness } from '../providers/qoder/host.ts'

const ROOT = join(import.meta.dirname, '../..')

function silentLog() {
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log }
  return log
}

function fakeContext(): Context {
  return { get: () => undefined } as unknown as Context
}

function pathsFor(root: string): HubPaths {
  return { home: root, dataDir: join(root, 'hub'), stateDir: join(root, 'hub', 'state') }
}

let cleanup: string | undefined
afterEach(async () => {
  if (cleanup !== undefined) {
    await rm(cleanup, { recursive: true, force: true })
    cleanup = undefined
  }
})

describe('timer lifecycle', () => {
  it('survives double dispose and ignores placements after dispose', async () => {
    const scheduler = new Scheduler(silentLog() as never)
    let ticks = 0
    scheduler.every('tick', 1_000, () => { ticks += 1 })
    scheduler.clear('missing-name')
    scheduler.dispose()
    expect(() => scheduler.dispose()).not.toThrow()
    // Placing a timer after dispose must not throw or schedule anything.
    expect(() => scheduler.every('late', 1_000, () => { ticks += 1 })).not.toThrow()
    expect(() => scheduler.setTimeout('late-timeout', -5, () => { ticks += 1 })).not.toThrow()
    scheduler.dispose()
    expect(ticks).toBe(0)
  })

  it('SingleFlight recovers after a rejected task', async () => {
    const flight = new SingleFlight<number>()
    await expect(flight.run(async () => { throw new Error('first failure') })).rejects.toThrow('first failure')
    // A rejected flight must not poison later calls.
    await expect(flight.run(async () => 7)).resolves.toBe(7)
  })
})

describe('prefs/vault fault tolerance', () => {
  it('loads defaults from a corrupt preferences file instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-prefs-'))
    cleanup = root
    const paths = pathsFor(root)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.dataDir, { recursive: true })
    await writeFile(join(paths.dataDir, 'preferences.json'), '{not json')
    const prefs = new PrefsStore(paths, silentLog() as never)
    await expect(prefs.load()).resolves.toBeUndefined()
    await expect(prefs.get('missing')).resolves.toBeUndefined()
    await prefs.dispose()
    await expect(prefs.dispose()).resolves.toBeUndefined()
  })

  it('treats a removed slot as empty and a double remove as harmless', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-'))
    cleanup = root
    const vault = new Vault(fakeContext(), pathsFor(root), silentLog() as never)
    await vault.remove('qoder-cn')
    await expect(vault.remove('qoder-cn')).resolves.toBeUndefined()
    await expect(vault.read('qoder-cn')).resolves.toBeUndefined()
  })
})

describe('provider runtime lifecycle', () => {
  it('double dispose is harmless and signed-out status never throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-lifecycle-'))
    cleanup = root
    const hosted = harness(root)
    const [cn] = createQoderProviders(hosted.deps)
    expect(cn).toBeDefined()
    // Status before init must also be safe (hub calls it after a failed init).
    expect(() => cn!.status()).not.toThrow()
    await cn!.init()
    try {
      expect(() => cn!.status()).not.toThrow()
      await expect(cn!.refreshAll()).resolves.toBeUndefined()
    } finally {
      await cn!.dispose()
      await expect(cn!.dispose()).resolves.toBeUndefined()
    }
    // Every runtime timer name is gone after dispose.
    expect([...hosted.scheduler.timers.keys()].filter(name => name.includes('qoder:'))).toEqual([])
  })

  it('background refreshes are routed through the non-rejecting helper', async () => {
    const source = await readFile(join(ROOT, 'src/providers/qoder/provider.ts'), 'utf8')
    // Every timer/fire-and-forget refresh must go through runBackgroundTask;
    // a bare `void this.refresh*()` would let a vault/service rejection escape
    // as an unhandled rejection (Node terminates the host process on those).
    expect(source).toContain('export function runBackgroundTask')
    expect(source).toMatch(/runInBackground\('catalog', \(\) => this\.refreshCatalog\(\)\)/)
    expect(source).toMatch(/runInBackground\('usage', \(\) => this\.refreshUsage\(\)\)/)
    expect(source).not.toMatch(/void this\.refresh(Catalog|Usage)\(\)/)
    expect(source).not.toMatch(/void this\.runScheduledCheckin\(\)/)
  })
})

describe('client storage hardening', () => {
  function storageWith(value: string | null, overrides: Partial<PreferenceStorage> = {}): PreferenceStorage {
    return {
      getItem: () => value,
      setItem: () => {},
      ...overrides,
    }
  }

  it('ignores prototype-pollution payloads in localStorage', () => {
    const store = new ClientPreferencesStore(storageWith(JSON.stringify({
      __proto__: { polluted: true },
      constructor: { prototype: { polluted: true } },
      seat: 'dock',
      family: 'trae',
      region: 'global',
    })))
    expect(store.get()).toEqual({ seat: 'dock', family: 'trae', region: 'global' })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(store.get()).not.toHaveProperty('__proto__')
  })

  it('falls back to defaults for malformed or wrong-typed storage', () => {
    expect(new ClientPreferencesStore(storageWith('not json')).get())
      .toEqual({ seat: 'toolbar', family: 'qoder', region: 'cn' })
    expect(new ClientPreferencesStore(storageWith(JSON.stringify({ seat: 'floor', family: 'x', region: 1 }))).get())
      .toEqual({ seat: 'toolbar', family: 'qoder', region: 'cn' })
    expect(new ClientPreferencesStore(storageWith(JSON.stringify(['dock']))).get())
      .toEqual({ seat: 'toolbar', family: 'qoder', region: 'cn' })
  })

  it('keeps its stored document free of secrets', () => {
    let written = ''
    const store = new ClientPreferencesStore(storageWith(null, { setItem: (_key, value) => { written = value } }))
    store.setSeat('dock')
    expect(JSON.parse(written)).toEqual({ seat: 'dock', family: 'qoder', region: 'cn' })
    expect(written).not.toMatch(/token|secret|pat|key/i)
    expect(CLIENT_PREFERENCES_STORAGE_KEY).toBe('dsh-connect-hub.preferences.v1')
  })

  it('survives a denied storage write', () => {
    const store = new ClientPreferencesStore(storageWith(null, {
      setItem: () => { throw new Error('quota exceeded') },
    }))
    expect(() => store.setSeat('dock')).not.toThrow()
    expect(store.get().seat).toBe('dock')
  })

  it('a throwing storage read falls back to defaults instead of breaking startup', () => {
    const store = new ClientPreferencesStore(storageWith(null, {
      getItem: () => { throw new DOMException('denied', 'SecurityError') },
    }))
    expect(store.get()).toEqual({ seat: 'toolbar', family: 'qoder', region: 'cn' })
    // The store keeps working in-memory for the rest of the page session.
    expect(() => store.setSeat('dock')).not.toThrow()
    expect(store.get().seat).toBe('dock')
  })
})

async function walkFiles(directory: string): Promise<string[]> {
  let entries: { isDirectory(): boolean, name: string }[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(path))
    else if (/\.(ts|tsx|mjs|sh|json|md|yml)$/u.test(entry.name)) files.push(path)
  }
  return files
}

describe('open-source hygiene', () => {
  it('no tracked source file embeds a personal home path or username', async () => {
    const files = [
      ...await walkFiles(join(ROOT, 'src')),
      join(ROOT, 'README.md'),
      join(ROOT, 'README.en.md'),
      join(ROOT, 'package.json'),
    ]
    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      // Fictional fixtures and docs are allowed to use placeholder users.
      if (/\/Users\/(?!alice\b)[A-Za-z0-9._-]+/u.test(text) || /\/home\/(?!alice\b)[A-Za-z0-9._-]+/u.test(text)) {
        offenders.push(relative(ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('the client contains no XSS sinks and no external assets', async () => {
    const files = await walkFiles(join(ROOT, 'src/client'))
    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      if (/dangerouslySetInnerHTML|\beval\(|new Function\s*\(|document\.write|insertAdjacentHTML|innerHTML\s*=/u.test(text)) {
        offenders.push(relative(ROOT, file))
      }
      if (/@import\s|url\(\s*['"]?https?:/u.test(text)) offenders.push(`external-asset:${relative(ROOT, file)}`)
    }
    expect(offenders).toEqual([])
  })

  it('the client only talks to the hub route itself', async () => {
    const files = await walkFiles(join(ROOT, 'src/client'))
    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/fetch\(\s*([^,)]+)/gu)) {
        const target = match[1]?.trim() ?? ''
        // Template literals rooted at the hub BASE path are the only allowed calls.
        if (!target.startsWith('`${BASE}')) offenders.push(`${relative(ROOT, file)}: ${target}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the repository carries an MIT license', async () => {
    const license = await readFile(join(ROOT, 'LICENSE'), 'utf8')
    expect(license).toContain('MIT License')
    expect(license).toContain('dsh-connect-hub contributors')
  })

  it('the .gitignore covers build output, dependencies and logs', async () => {
    const ignore = await readFile(join(ROOT, '.gitignore'), 'utf8')
    for (const pattern of ['node_modules/', 'lib/', '*.log', '.DS_Store']) {
      expect(ignore).toContain(pattern)
    }
  })

  it('action failure details are redacted before reaching the browser', async () => {
    const source = await readFile(join(ROOT, 'src/index.ts'), 'utf8')
    // The dispatch catch must sanitize the message it returns as `detail`; the
    // logger path is already redacted by createHubLogger.
    expect(source).toMatch(/detail:\s*redactHome\(stripInternalErrorMarkers\(redactText\(raw\)\), paths\.home\)/)
    expect(source).not.toMatch(/detail:\s*error instanceof Error \? error\.message/)
  })

  it('the dev-server script resolves pnpm portably', async () => {
    const script = await readFile(join(ROOT, 'scripts/dev-server.sh'), 'utf8')
    expect(script).toContain('PNPM_BIN')
    expect(script).toContain('command -v pnpm')
    expect(script).toContain('DSH_RUNTIME_PNPM')
  })

  it('a non-loopback web-server origin is reported as local-only', async () => {
    const source = await readFile(join(ROOT, 'src/index.ts'), 'utf8')
    expect(source).toContain('the hub browser surface is local-only')
    expect(source).toContain("ctx.inject(['webServer']")
  })

  it('scripts contain no machine-specific personal path', async () => {
    const files = await walkFiles(join(ROOT, 'scripts'))
    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      if (/\/Users\/[A-Za-z0-9._-]+/u.test(text)) offenders.push(relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })
})
