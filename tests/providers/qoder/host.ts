import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ProviderDeps } from '../../../src/core/types.ts'
import type { HubPaths } from '../../../src/core/paths.ts'
import type { SecretSlot, Vault } from '../../../src/core/vault.ts'
import { testLogger } from './fakes.ts'

/** In-memory vault seam for runtime tests; no host credential service involved. */
export class MemoryVault {
  readonly slots = new Map<SecretSlot, unknown>()
  async read<T>(slot: SecretSlot): Promise<T | undefined> { return this.slots.get(slot) as T | undefined }
  async write<T>(slot: SecretSlot, value: T): Promise<void> { this.slots.set(slot, value) }
  async remove(slot: SecretSlot): Promise<void> { this.slots.delete(slot) }
  async describe(slot: SecretSlot): Promise<{ configured: boolean; writable: boolean }> {
    return { configured: this.slots.has(slot), writable: true }
  }
}

/** In-memory prefs seam; values are exactly what `status()`/actions read back. */
export class MemoryPrefs {
  readonly values = new Map<string, unknown>()
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined }
  async set<T>(key: string, value: T): Promise<void> { this.values.set(key, value) }
  async patch<T extends Record<string, unknown>>(key: string, patch: Partial<T>): Promise<T> {
    const next = { ...(this.values.get(key) as T | undefined ?? {} as T), ...patch }
    this.values.set(key, next)
    return next
  }
  async load(): Promise<void> {}
  async flush(): Promise<void> {}
  async dispose(): Promise<void> {}
}

export interface RecordedTimer {
  kind: 'every' | 'timeout' | 'atUtc8'
  minute?: number
  intervalMs?: number
}

/** In-memory scheduler seam that records placements instead of arming timers. */
export class MemoryScheduler {
  readonly timers = new Map<string, RecordedTimer>()
  every(name: string, intervalMs: number): void {
    this.timers.set(name, { kind: 'every', intervalMs })
  }
  setTimeout(name: string): void { this.timers.set(name, { kind: 'timeout' }) }
  atUtc8Minute(name: string, minute: number): void { this.timers.set(name, { kind: 'atUtc8', minute }) }
  clear(name: string): void { this.timers.delete(name) }
  dispose(): void { this.timers.clear() }
}

export interface Harness {
  deps: ProviderDeps
  vault: MemoryVault
  prefs: MemoryPrefs
  scheduler: MemoryScheduler
  emitted: string[]
  adapterRegistrations: string[][]
  directoryEntries: { provider: string; settingsNs: string }[]
  paths: HubPaths
}

/**
 * A fake host environment for one runtime: in-memory vault/prefs/scheduler,
 * a recording cordis context, and a temp home/profile directory. No network.
 */
export function harness(root: string, profileDir?: string): Harness {
  const vault = new MemoryVault()
  const prefs = new MemoryPrefs()
  const scheduler = new MemoryScheduler()
  const emitted: string[] = []
  const adapterRegistrations: string[][] = []
  const directoryEntries: { provider: string; settingsNs: string }[] = []
  const paths: HubPaths = {
    home: root,
    ...profileDir === undefined ? {} : { profileDir },
    dataDir: join(profileDir ?? root, '.dsh-connect-hub'),
    stateDir: join(profileDir ?? root, '.dsh-connect-hub', 'state'),
  }
  const ctx = {
    get: () => undefined,
    emit: (event: string) => { emitted.push(event) },
    llm: {
      registerAdapter: (providers: string[]) => {
        adapterRegistrations.push([...providers])
        return () => {}
      },
      registerConfigurableProviders: (entries: readonly { provider: string; settingsNs: string }[]) => {
        for (const entry of entries) directoryEntries.push({ provider: entry.provider, settingsNs: entry.settingsNs })
        return () => {}
      },
    },
  } as unknown as Context
  const deps: ProviderDeps = {
    ctx,
    paths,
    prefs: prefs as unknown as ProviderDeps['prefs'],
    vault: vault as unknown as Vault,
    log: testLogger(),
    scheduler: scheduler as unknown as ProviderDeps['scheduler'],
    version: '0.0.0-test',
    notifyChanged: () => {},
  }
  return { deps, vault, prefs, scheduler, emitted, adapterRegistrations, directoryEntries, paths }
}
