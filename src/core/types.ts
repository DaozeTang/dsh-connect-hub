import type { Context } from '@deepseek-ai/cordis'
import type {
  BilingualText,
  HubAction,
  ProviderFamily,
  ProviderId,
  ProviderStatus,
  Region,
} from '../shared/contracts.ts'
import type { HubLogger } from './log.ts'
import type { HubPaths } from './paths.ts'
import type { PrefsStore } from './prefs.ts'
import type { Scheduler } from './scheduler.ts'
import type { Vault } from './vault.ts'

export interface ProviderDescriptor {
  id: ProviderId
  family: ProviderFamily
  region: Region
  label: BilingualText
}

export interface ProviderDeps {
  ctx: Context
  paths: HubPaths
  prefs: PrefsStore
  vault: Vault
  log: HubLogger
  scheduler: Scheduler
  version: string
  notifyChanged(): void
}

export interface ProviderActionResult {
  message?: string
  /** Stable message code the browser localizes; `message` stays for logs. */
  code?: string
  params?: Readonly<Record<string, string | number>>
  data?: unknown
}

/**
 * One provider action that genuinely failed to do what it was asked.
 *
 * Thrown instead of returned as a success-shaped message, so the HTTP layer
 * answers `{ ok: false, error, detail }` and the UI renders an error tone. The
 * code is stable and machine-readable; the message is the redacted human text.
 */
export class ProviderActionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProviderActionError'
    this.code = code
  }
}

export interface ProviderRuntime {
  readonly descriptor: ProviderDescriptor
  init(): Promise<void>
  dispose(): Promise<void>
  status(): ProviderStatus
  refreshAll(): Promise<void>
  action(action: HubAction): Promise<ProviderActionResult>
}

export type ProviderFactory = (deps: ProviderDeps) => ProviderRuntime[]

/** The deps handed to every provider runtime; same shape as {@link ProviderDeps}. */
export type HubRuntimeDeps = ProviderDeps
