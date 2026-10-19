import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { HubLogger } from '../../../src/core/log.ts'
import type { HubPaths } from '../../../src/core/paths.ts'
import type { PrefsStore } from '../../../src/core/prefs.ts'
import type { Scheduler } from '../../../src/core/scheduler.ts'
import type { SecretSlot, Vault } from '../../../src/core/vault.ts'
import type { ProviderDeps } from '../../../src/core/types.ts'
import type { TraeCredentialPersistence } from '../../../src/providers/trae/auth.ts'
import type { TraeCredential } from '../../../src/providers/trae/auth.ts'

export async function makeTempDir(prefix = 'trae-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** In-memory vault with the same read/write/modify semantics as the real one. */
export class MemoryVault {
  private readonly slots = new Map<SecretSlot, unknown>()

  async read<T>(slot: SecretSlot): Promise<T | undefined> {
    return this.slots.get(slot) as T | undefined
  }

  async write<T>(slot: SecretSlot, value: T): Promise<void> {
    this.slots.set(slot, value)
  }

  async modify<T>(
    slot: SecretSlot,
    mutate: (current: T | undefined) => Promise<T | undefined> | T | undefined,
  ): Promise<T | undefined> {
    const updated = await mutate(this.slots.get(slot) as T | undefined)
    if (updated !== undefined) this.slots.set(slot, updated)
    return updated
  }

  async remove(slot: SecretSlot): Promise<void> {
    this.slots.delete(slot)
  }

  async describe(slot: SecretSlot): Promise<{ configured: boolean; writable: boolean }> {
    return { configured: this.slots.has(slot), writable: true }
  }

  /** Seed a slot without going through the vault API. */
  seed(slot: SecretSlot, value: unknown): void {
    this.slots.set(slot, value)
  }

  peek(slot: SecretSlot): unknown {
    return this.slots.get(slot)
  }
}

/** In-memory preferences store. */
export class MemoryPrefs {
  private readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async patch<T extends Record<string, unknown>>(key: string, patch: Partial<T>): Promise<T> {
    const next = { ...(this.values.get(key) as T | undefined), ...patch } as T
    this.values.set(key, next)
    return next
  }

  async load(): Promise<void> {}

  async flush(): Promise<void> {}

  async dispose(): Promise<void> {}

  peek(key: string): unknown {
    return this.values.get(key)
  }
}

export interface ScheduledCall {
  kind: 'every' | 'setTimeout' | 'atUtc8Minute'
  name: string
  value: number
  run: () => Promise<void> | void
}

/** Scheduler double: records registrations, never starts a real timer. */
export class FakeScheduler {
  readonly calls: ScheduledCall[] = []

  every(name: string, intervalMs: number, run: () => Promise<void> | void): void {
    this.calls.push({ kind: 'every', name, value: intervalMs, run })
  }

  setTimeout(name: string, delayMs: number, run: () => Promise<void> | void): void {
    this.calls.push({ kind: 'setTimeout', name, value: delayMs, run })
  }

  atUtc8Minute(name: string, minute: number, run: () => Promise<void> | void): void {
    this.calls.push({ kind: 'atUtc8Minute', name, value: minute, run })
  }

  clear(_name: string): void {}

  dispose(): void {}
}

export function noopLogger(): HubLogger {
  const logger: HubLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  }
  return logger
}

export interface FakeLlm {
  readonly registered: string[][]
  readonly replacements: string[][]
  readonly directory: { provider: string; settingsNs: string }[]
  readonly events: string[]
  /** Adapter instances registered by the runtimes, in registration order. */
  readonly adapters: unknown[]
  disposed: boolean
}

export interface FakeDepsBundle {
  deps: ProviderDeps
  vault: MemoryVault
  prefs: MemoryPrefs
  scheduler: FakeScheduler
  llm: FakeLlm
  notified: () => number
  emitterEvents: string[]
  paths: HubPaths
}

/** Full `ProviderDeps` double backed by memory stores and a fake llm service. */
export function makeFakeDeps(options: { home: string; dataDir?: string; profileDir?: string }): FakeDepsBundle {
  const dataDir = options.dataDir ?? join(options.home, '.dsh-connect-hub')
  const paths: HubPaths = {
    home: options.home,
    dataDir,
    stateDir: join(dataDir, 'state'),
    ...options.profileDir === undefined ? {} : { profileDir: options.profileDir },
  }
  const vault = new MemoryVault()
  const prefs = new MemoryPrefs()
  const scheduler = new FakeScheduler()
  const events: string[] = []
  let notifications = 0
  const llm: FakeLlm = {
    registered: [],
    replacements: [],
    directory: [],
    events,
    adapters: [],
    disposed: false,
  }
  const makeHandle = (): { (): void; replace: (providers: string[]) => void } => {
    const handle = ((): void => {
      llm.disposed = true
    }) as { (): void; replace: (providers: string[]) => void }
    handle.replace = (providers: string[]) => {
      llm.replacements.push(providers)
    }
    return handle
  }
  const ctx = {
    llm: {
      registerAdapter: (providers: string[], adapter?: unknown) => {
        llm.registered.push(providers)
        llm.adapters.push(adapter)
        return makeHandle()
      },
      registerConfigurableProviders: (entries: { provider: string; settingsNs: string }[]) => {
        llm.directory.push(...entries.map(entry => ({ provider: entry.provider, settingsNs: entry.settingsNs })))
        return () => {}
      },
    },
    get: () => undefined,
    emit: (name: string) => {
      events.push(name)
    },
  } as unknown as Context
  const deps: ProviderDeps = {
    ctx,
    paths,
    prefs: prefs as unknown as PrefsStore,
    vault: vault as unknown as Vault,
    log: noopLogger(),
    scheduler: scheduler as unknown as Scheduler,
    version: '0.0.0-test',
    notifyChanged: () => {
      notifications += 1
    },
  }
  return {
    deps,
    vault,
    prefs,
    scheduler,
    llm,
    notified: () => notifications,
    emitterEvents: events,
    paths,
  }
}

/** A minimal persisted v2 credential row for tests. */
export function storedCredential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    userId: 'user-1',
    host: 'https://api.trae.cn',
    userRegion: 'CN',
    expiresAtMs: Date.now() + 3_600_000,
    edition: 'cn',
    source: 'dsh',
    ...overrides,
  }
}

/** Test/diagnostic persistence over a plain array. */
export class MemoryTraeCredentialPersistence implements TraeCredentialPersistence {
  private credentials: TraeCredential[]

  constructor(initial: readonly TraeCredential[] = []) {
    this.credentials = [...initial]
  }

  async read(): Promise<TraeCredential[]> {
    return [...this.credentials]
  }

  async write(credentials: readonly TraeCredential[]): Promise<void> {
    this.credentials = [...credentials]
  }

  async update(mutate: (current: readonly TraeCredential[]) => readonly TraeCredential[]): Promise<void> {
    this.credentials = [...mutate([...this.credentials])]
  }
}
