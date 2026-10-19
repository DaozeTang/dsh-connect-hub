import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ProviderDeps } from '../../src/core/types.ts'
import type { HubPaths } from '../../src/core/paths.ts'
import { PrefsStore } from '../../src/core/prefs.ts'
import { Scheduler } from '../../src/core/scheduler.ts'
import { Vault } from '../../src/core/vault.ts'
import { createHubLogger } from '../../src/core/log.ts'

type Listener = (...args: unknown[]) => void

export interface FakeHost {
  deps: ProviderDeps
  events: { name: string; args: unknown[] }[]
  adapters: string[]
  directories: string[]
  logLines: string[]
  notifyCount(): number
  cleanup(): Promise<void>
}

export async function createFakeHost(options: {
  home?: string | undefined
  profileDir?: string | undefined
  dataDir?: string | undefined
} = {}): Promise<FakeHost> {
  const root = await mkdtemp(join(tmpdir(), 'hub-fake-'))
  const dataDir = options.dataDir ?? join(root, 'data')
  const paths: HubPaths = {
    home: options.home ?? root,
    dataDir,
    stateDir: join(dataDir, 'state'),
  }
  if (options.profileDir !== undefined) paths.profileDir = options.profileDir

  const listeners = new Map<string, Set<Listener>>()
  const events: { name: string; args: unknown[] }[] = []
  const adapters: string[] = []
  const directories: string[] = []
  const logLines: string[] = []
  let notifications = 0
  let credentials: unknown

  const context = {
    get: (name: string) => {
      if (name === 'credentials') return credentials
      if (name === 'profileContext') return options.profileDir === undefined ? undefined : { dir: options.profileDir }
      return undefined
    },
    logger: {
      info: (message: string) => { logLines.push(`info ${message}`) },
      warn: (message: string) => { logLines.push(`warn ${message}`) },
      error: (message: string) => { logLines.push(`error ${message}`) },
    },
    effect: (fn: () => unknown) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') (dispose as () => void)()
      }
    },
    inject: (_services: string[], callback: (scope: unknown) => unknown) => {
      const dispose = callback(context)
      return () => {
        if (typeof dispose === 'function') (dispose as () => void)()
      }
    },
    on: (name: string, listener: Listener) => {
      const set = listeners.get(name) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(name, set)
      return () => { set.delete(listener) }
    },
    emit: (name: string, ...args: unknown[]) => {
      events.push({ name, args })
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    fiber: { entry: { options: { id: 'connect-hub' } } },
    plugin: () => ({ dispose: () => {} }),
    llm: {
      registerAdapter: (providers: string[]) => {
        adapters.push(...providers)
        const handle = (() => {
          for (const provider of providers) {
            const index = adapters.indexOf(provider)
            if (index >= 0) adapters.splice(index, 1)
          }
        }) as (() => void) & { replace: (next: string[]) => void }
        handle.replace = () => {}
        return handle
      },
      registerConfigurableProviders: (entries: readonly { provider: string }[]) => {
        directories.push(...entries.map((entry) => entry.provider))
        return () => {
          for (const entry of entries) {
            const index = directories.indexOf(entry.provider)
            if (index >= 0) directories.splice(index, 1)
          }
        }
      },
      registerModelDiscovery: () => () => {},
      listConfigurableProviders: () => [],
    },
  }

  const ctx = context as unknown as Context
  const log = createHubLogger(ctx, paths.home)
  const deps: ProviderDeps = {
    ctx,
    paths,
    prefs: new PrefsStore(paths, log),
    vault: new Vault(ctx, paths, log),
    log,
    scheduler: new Scheduler(log),
    version: '0.0.0-test',
    notifyChanged: () => { notifications += 1 },
  }
  await deps.prefs.load()

  return {
    deps,
    events,
    adapters,
    directories,
    logLines,
    notifyCount: () => notifications,
    cleanup: async () => {
      deps.scheduler.dispose()
      await deps.prefs.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export function setFakeCredentials(host: FakeHost, credentials: unknown): void {
  const context = host.deps.ctx as unknown as { get: (name: string) => unknown }
  const original = context.get
  context.get = (name: string) => (name === 'credentials' ? credentials : original(name))
}
