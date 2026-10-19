/**
 * Shared state handed to every settings section: the live provider status, a
 * single action runner that reconciles the snapshot from the returned status,
 * and the busy-cell key so independent controls can disable themselves.
 */

import { createContext, useContext } from 'react'
import type { HubAction, HubStatus, ProviderStatus } from '../shared/contracts.ts'
import type { ConnectHubTranslate } from './format.ts'

/** Normalized outcome of one hub action, ready for inline feedback. */
export interface RunResult {
  ok: boolean
  message?: string
  error?: string
  data?: unknown
  status?: HubStatus
}

export interface HubUiValue {
  t: ConnectHubTranslate
  status: HubStatus
  provider: ProviderStatus
  /** Busy-cell key of the action in flight; matches `actionBusyKey(action)`. */
  busy: string | null
  /** Reference "now" for relative labels (the snapshot's own clock). */
  now: number
  run(action: HubAction): Promise<RunResult>
  /** Apply a projection first, then reconcile; a failure reverts it. */
  runOptimistic(action: HubAction, project: (status: HubStatus) => HubStatus): Promise<RunResult>
}

export const HubUiContext = createContext<HubUiValue | null>(null)

/** Read the section context; sections only render inside the settings page. */
export function useHubUi(): HubUiValue {
  const value = useContext(HubUiContext)
  if (value === null) throw new Error('Connect Hub section rendered outside HubSettingsPage')
  return value
}

/** Replace one provider inside a hub snapshot (optimistic projections). */
export function mapProvider(
  status: HubStatus,
  providerId: ProviderStatus['id'],
  project: (provider: ProviderStatus) => ProviderStatus,
): HubStatus {
  return {
    ...status,
    providers: status.providers.map((provider) => (provider.id === providerId ? project(provider) : provider)),
  }
}
