/**
 * Probe orchestration: consent gate, serial execution, and the bridge between a
 * finished observation and what the adapter may expose.
 *
 * Two structural rules: only one sweep runs at a time, and nothing runs without
 * explicit consent.
 */

import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyCredential, WorkBuddyCredentialSource } from './auth.ts'
import { probeModel, type ProbeAttempt, type ProbeRegion, type ProbeSender, type SentinelFactory } from './probe.ts'
import { fingerprintModel, type WorkBuddyProbeRecord, type WorkBuddyProbeStore } from './probe-store.ts'

/** The service surface the runtime's HTTP client provides. */
export interface WorkBuddyProbeSource {
  probeEffort(
    credential: WorkBuddyCredential,
    model: string,
    effort: string | undefined,
    signal: AbortSignal,
  ): Promise<ProbeAttempt>
}

/** What the caller learns about one completed probe. */
export type WorkBuddyProbeStatus =
  | { state: 'ok'; validation: WorkBuddyProbeRecord['validation']; efforts: readonly string[]; requests: number }
  | { state: 'unavailable'; reason: string }

/** Options for {@link WorkBuddyProbeService}. */
export interface WorkBuddyProbeServiceOptions {
  store: WorkBuddyProbeStore
  catalog: WorkBuddyCatalog
  credentials: WorkBuddyCredentialSource
  client: WorkBuddyProbeSource
  /** Whether probing is permitted at all; consulted before and during a sweep. */
  consent: () => boolean
  /**
   * The account currently in effect, as `uid:enterpriseId`, or `undefined`
   * while signed out. Records are read and written against this identity, and
   * it is re-checked around the sweep so account A's observation is never
   * stored once account B is in effect.
   */
  account: () => string | undefined
  sentinel?: SentinelFactory
  /** Which endpoint's rejection vocabulary sweeps read. */
  region: ProbeRegion
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender
}

/** Models that still need detection: reasoning-capable with no declared set. */
function needsDetection(info: WorkBuddyModelInfo): boolean {
  if (info.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/**
 * Serial probe runner. One instance per route, so manual and automatic triggers
 * can never overlap.
 */
export class WorkBuddyProbeService {
  private readonly options: WorkBuddyProbeServiceOptions
  private tail: Promise<unknown> = Promise.resolve()
  private readonly inFlight = new Map<string, Promise<WorkBuddyProbeStatus>>()
  private busy = false

  constructor(options: WorkBuddyProbeServiceOptions) {
    this.options = options
  }

  /** Whether a sweep is in flight right now. */
  isRunning(): boolean {
    return this.busy
  }

  /** Current catalog row for one model id, if this route serves it. */
  private modelOf(modelId: string) {
    return this.options.catalog.current().find((info) => info.id === modelId)
  }

  /** Whether consent currently allows a sweep. */
  private allowed(manualConsent: boolean): boolean {
    return manualConsent || this.options.consent()
  }

  /**
   * The record the adapter may use for this model, or `undefined`. A declared
   * effort set always wins, so such models are never answered from an
   * observation.
   */
  recordFor(modelId: string): WorkBuddyProbeRecord | undefined {
    const info = this.modelOf(modelId)
    return info === undefined ? undefined : this.recordForRow(info)
  }

  /**
   * Record for a catalog row the caller already resolved. The status document
   * has the rows in hand; going through {@link recordFor} per model would scan
   * the catalog (and recompute promotions) once per row, which is O(N²).
   */
  recordForRow(info: WorkBuddyModelInfo, account = this.options.account()): WorkBuddyProbeRecord | undefined {
    if ((info.reasoning?.supportedEfforts?.length ?? 0) > 0) return undefined
    if (account === undefined) return undefined
    return this.options.store.get(info.id, fingerprintModel(info), account)
  }

  /**
   * The usable record for every catalog row, computed in one pass. Fingerprints
   * are hashed once per row, not once per status consumer.
   */
  recordsFor(models: readonly WorkBuddyModelInfo[]): ReadonlyMap<string, WorkBuddyProbeRecord> {
    const account = this.options.account()
    const records = new Map<string, WorkBuddyProbeRecord>()
    if (account === undefined) return records
    for (const info of models) {
      const record = this.recordForRow(info, account)
      if (record !== undefined) records.set(info.id, record)
    }
    return records
  }

  /**
   * Probe one model, serially.
   *
   * A manual call supplies one-shot consent after UI confirmation; other callers
   * go through the configured consent gate. Manual consent never changes the
   * automatic configuration. Manual requests bypass historical results but share
   * an already-running sweep.
   */
  async probe(modelId: string, manualConsent = false): Promise<WorkBuddyProbeStatus> {
    if (!this.allowed(manualConsent)) return { state: 'unavailable', reason: 'probing is not authorized' }
    if (this.modelOf(modelId) === undefined) {
      return { state: 'unavailable', reason: `unknown model: ${modelId}` }
    }
    const account = this.options.account()
    if (account === undefined) return { state: 'unavailable', reason: 'no WorkBuddy credential' }

    const dedupeKey = JSON.stringify([account, modelId])
    const joined = this.inFlight.get(dedupeKey)
    if (joined !== undefined) return joined

    const run = this.tail.then(async (): Promise<WorkBuddyProbeStatus> => {
      // Re-read inside the queue: the catalog may have changed or another sweep
      // may already have answered this model.
      const info = this.modelOf(modelId)
      if (info === undefined) return { state: 'unavailable', reason: `unknown model: ${modelId}` }
      if (!this.allowed(manualConsent)) return { state: 'unavailable', reason: 'probing is not authorized' }
      if (!needsDetection(info)) return { state: 'unavailable', reason: 'model does not need detection' }

      const cached = this.recordFor(modelId)
      if (!manualConsent && cached !== undefined && cached.validation !== 'unknown') {
        return { state: 'ok', validation: cached.validation, efforts: cached.efforts, requests: 0 }
      }

      // Capture the account before sending anything; a probe can outlive it.
      if (this.options.account() !== account) {
        return { state: 'unavailable', reason: 'account changed before detection' }
      }
      const credential = await this.options.credentials.current()
      if (credential === undefined) return { state: 'unavailable', reason: 'no WorkBuddy credential' }

      const send =
        this.options.send === undefined
          ? (effort: string | undefined, signal: AbortSignal) =>
              this.options.client.probeEffort(credential, modelId, effort, signal)
          : this.options.send(modelId)

      this.busy = true
      try {
        const outcome = await probeModel({
          send,
          region: this.options.region,
          ...(this.options.sentinel === undefined ? {} : { sentinel: this.options.sentinel }),
        })
        // The account may have moved while requests were in flight; drop the
        // observation rather than attribute it to whoever is signed in now.
        if (this.options.account() !== account) {
          return { state: 'unavailable', reason: 'account changed during detection' }
        }
        const record = this.options.store.record(fingerprintModel(info), outcome.validation, outcome.efforts, account)
        await this.options.store.set(modelId, record)
        if (outcome.validation === 'unknown') return { state: 'unavailable', reason: outcome.reason }
        return { state: 'ok', validation: outcome.validation, efforts: record.efforts, requests: outcome.requests }
      } finally {
        this.busy = false
      }
    })

    // Keep the chain alive whatever this run's outcome, so one failure cannot
    // poison every later probe.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.inFlight.set(dedupeKey, run)
    try {
      return await run
    } finally {
      this.inFlight.delete(dedupeKey)
    }
  }
}
