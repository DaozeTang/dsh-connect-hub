/**
 * Shared test doubles for the WorkBuddy provider specs.
 *
 * Everything here is offline: no real WorkBuddy app, no network, no user home.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { HubLogger } from '../../../src/core/log.ts'
import type { HubPaths } from '../../../src/core/paths.ts'
import { PrefsStore } from '../../../src/core/prefs.ts'
import { Scheduler } from '../../../src/core/scheduler.ts'
import { Vault } from '../../../src/core/vault.ts'
import type { ProviderDeps } from '../../../src/core/types.ts'

/** In-memory preferences store used by the persistence-layer specs. */
export class FakePrefs {
  readonly values = new Map<string, unknown>()
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }
}

/** In-memory vault double; `modify` performs an exclusive read-modify-write. */
export class FakeVault {
  readonly slots = new Map<string, unknown>()
  readonly writes: string[] = []
  private queue: Promise<unknown> = Promise.resolve()
  async read<T>(slot: string): Promise<T | undefined> {
    return this.slots.get(slot) as T | undefined
  }
  async modify<T>(
    slot: string,
    mutate: (current: T | undefined) => Promise<T | undefined> | T | undefined,
  ): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      const next = await mutate(this.slots.get(slot) as T | undefined)
      if (next !== undefined) {
        this.slots.set(slot, next)
        this.writes.push(slot)
      }
      return next
    }
    const next = this.queue.then(run, run)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  async remove(slot: string): Promise<void> {
    this.slots.delete(slot)
  }
}

/** A logger that records nothing; the behavior under test is the state, not logs. */
export function silentLog(): HubLogger {
  const log: HubLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  }
  return log
}

/** One captured adapter registration. */
export interface AdapterRegistration {
  providers: string[]
  released: boolean
}

/** A minimal context: service lookups all miss, events and adapter registrations are recorded. */
export function fakeContext(): { ctx: Context, emitted: string[], adapters: AdapterRegistration[] } {
  const emitted: string[] = []
  const adapters: AdapterRegistration[] = []
  const ctx = {
    get: () => undefined,
    emit: (event: string) => {
      emitted.push(event)
    },
    llm: {
      registerAdapter: (providers: string[]) => {
        const registration: AdapterRegistration = { providers, released: false }
        adapters.push(registration)
        return () => {
          registration.released = true
        }
      },
    },
  } as unknown as Context
  return { ctx, emitted, adapters }
}

/** A runtime harness: real core stores on temporary paths, fake context. */
export interface TestDeps {
  deps: ProviderDeps
  emitted: string[]
  adapters: AdapterRegistration[]
  notifications: () => number
  paths: HubPaths
  prefs: PrefsStore
  vault: Vault
  scheduler: Scheduler
  cleanup: () => Promise<void>
}

/** Build a fully offline {@link ProviderDeps} rooted in a fresh temporary directory. */
export async function createTestDeps(): Promise<TestDeps> {
  const home = await mkdtemp(join(tmpdir(), 'hub-workbuddy-'))
  const paths: HubPaths = {
    home,
    dataDir: join(home, 'data'),
    stateDir: join(home, 'data', 'state'),
  }
  const log = silentLog()
  const prefs = new PrefsStore(paths, log)
  await prefs.load()
  const scheduler = new Scheduler(log)
  const { ctx, emitted, adapters } = fakeContext()
  const vault = new Vault(ctx, paths, log)
  let notificationCount = 0
  const deps: ProviderDeps = {
    ctx,
    paths,
    prefs,
    vault,
    log,
    scheduler,
    version: '0.1.0-test',
    notifyChanged: () => {
      notificationCount += 1
    },
  }
  return {
    deps,
    emitted,
    adapters,
    notifications: () => notificationCount,
    paths,
    prefs,
    vault,
    scheduler,
    cleanup: async () => {
      scheduler.dispose()
      await prefs.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** Wait one macrotask, so fire-and-forget persistence in a store can settle. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
