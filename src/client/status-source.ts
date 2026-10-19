/**
 * Status fetching engines.
 *
 * `HubStatusSource` backs the settings page: one GET on mount, then a poll
 * that only runs while the page is mounted AND visible, so a background tab
 * never keeps the host busy. `ComposerStatusSource` backs the composer
 * readout: no timer at all, at most one read per five minutes plus explicit
 * refreshes from the popover. Both publish reference-stable snapshots through
 * `useSyncExternalStore`.
 */

import type { HubStatus } from '../shared/contracts.ts'
import { fetchStatus } from './api.ts'

/** Poll cadence of the settings page while it is visible. */
export const SETTINGS_POLL_MS = 5_000

/** Maximum age of the composer readout before it re-reads on show. */
export const COMPOSER_FRESH_MS = 5 * 60_000

export interface HubStatusSnapshot {
  readonly status: HubStatus | null
  /** True until the first read settles. */
  readonly loading: boolean
  /** True while an explicit refresh is in flight. */
  readonly refreshing: boolean
  /** Last read failure; the cached status (if any) stays visible. */
  readonly error: string | null
  readonly loadedAt: number | null
}

const EMPTY_SNAPSHOT: HubStatusSnapshot = {
  status: null,
  loading: true,
  refreshing: false,
  error: null,
  loadedAt: null,
}

/** Human-readable text of an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

type Visibility = 'visible' | 'hidden'

interface StatusSourceOptions {
  load?: () => Promise<HubStatus>
  intervalMs?: number
  visibility?: () => Visibility
  subscribeVisibility?: (listener: () => void) => () => void
  now?: () => number
}

function currentVisibility(): Visibility {
  if (typeof document === 'undefined') return 'visible'
  return document.visibilityState === 'hidden' ? 'hidden' : 'visible'
}

function onVisibilityChange(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', listener)
  return () => { document.removeEventListener('visibilitychange', listener) }
}

function sameSnapshot(left: HubStatusSnapshot, right: HubStatusSnapshot): boolean {
  return left.status === right.status
    && left.loading === right.loading
    && left.refreshing === right.refreshing
    && left.error === right.error
    && left.loadedAt === right.loadedAt
}

/** Settings-page status engine: mount-scoped polling plus manual refresh. */
export class HubStatusSource {
  private readonly load: () => Promise<HubStatus>
  private readonly intervalMs: number
  private readonly visibility: () => Visibility
  private readonly subscribeVisibility: (listener: () => void) => () => void
  private readonly now: () => number

  private snapshot: HubStatusSnapshot = EMPTY_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private detachVisibility: (() => void) | null = null
  private inflight: Promise<void> | null = null
  private generation = 0
  private started = false

  constructor(options: StatusSourceOptions = {}) {
    this.load = options.load ?? fetchStatus
    this.intervalMs = options.intervalMs ?? SETTINGS_POLL_MS
    this.visibility = options.visibility ?? currentVisibility
    this.subscribeVisibility = options.subscribeVisibility ?? onVisibilityChange
    this.now = options.now ?? (() => Date.now())
  }

  readonly getSnapshot = (): HubStatusSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.detachVisibility = this.subscribeVisibility(() => {
      if (this.visibility() === 'visible') void this.read('auto')
    })
    this.timer = setInterval(() => {
      if (this.visibility() === 'visible') void this.read('auto')
    }, this.intervalMs)
    void this.read('auto')
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.generation += 1
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.detachVisibility?.()
    this.detachVisibility = null
    this.inflight = null
  }

  /** Explicit user refresh: always re-reads and shows the spinner. */
  async refresh(): Promise<void> {
    this.publish({ ...this.snapshot, refreshing: true })
    await this.read('manual')
  }

  /** Re-read without the manual spinner (used by tests and permission retries). */
  async reload(): Promise<void> {
    await this.read('auto')
  }

  /** Reconcile the snapshot from an action's returned status. */
  apply(next: HubStatus): void {
    this.publish({ status: next, loading: false, refreshing: false, error: null, loadedAt: this.now() })
  }

  /**
   * Apply an optimistic projection over the cached status. Returns the status
   * captured before the change so a failed action can revert it.
   */
  mutate(project: (current: HubStatus) => HubStatus): HubStatus | null {
    const current = this.snapshot.status
    if (current === null) return null
    this.publish({ ...this.snapshot, status: project(current), error: null })
    return current
  }

  private async read(mode: 'auto' | 'manual'): Promise<void> {
    if (this.inflight !== null) {
      if (mode === 'manual') {
        this.publish({ ...this.snapshot, refreshing: true })
      }
      await this.inflight
      return
    }
    const generation = this.generation
    const task = (async (): Promise<void> => {
      try {
        const status = await this.load()
        if (generation !== this.generation) return
        const previous = this.snapshot
        const unchanged = mode === 'auto'
          && previous.status !== null
          && previous.status.revision === status.revision
          && status.providers.length === previous.status.providers.length
        // A poll matching the cached revision must not churn subscribers: the
        // host bumps `revision` whenever a field it reports moves, so unchanged
        // revision means an unchanged document. Keep the cached `loadedAt` too,
        // or every poll would still publish a new snapshot.
        if (unchanged) {
          if (previous.loading || previous.error !== null) {
            this.publish({ ...previous, loading: false, refreshing: false, error: null })
          }
          return
        }
        this.publish({
          status,
          loading: false,
          refreshing: false,
          error: null,
          loadedAt: this.now(),
        })
      } catch (error) {
        if (generation !== this.generation) return
        this.publish({ ...this.snapshot, loading: false, refreshing: false, error: describeError(error) })
      }
    })()
    this.inflight = task
    try {
      await task
    } finally {
      if (this.inflight === task) this.inflight = null
    }
  }

  private publish(next: HubStatusSnapshot): void {
    if (sameSnapshot(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

export interface ComposerSnapshot {
  readonly status: HubStatus | null
  readonly loading: boolean
  readonly refreshing: boolean
  readonly error: string | null
  readonly loadedAt: number | null
}

const EMPTY_COMPOSER: ComposerSnapshot = { status: null, loading: false, refreshing: false, error: null, loadedAt: null }

interface ComposerOptions {
  load?: () => Promise<HubStatus>
  freshMs?: number
  now?: () => number
}

/** Composer readout engine: stale-while-revalidate with a five-minute floor. */
export class ComposerStatusSource {
  private readonly load: () => Promise<HubStatus>
  private readonly freshMs: number
  private readonly now: () => number
  private snapshot: ComposerSnapshot = EMPTY_COMPOSER
  private readonly listeners = new Set<() => void>()
  private inflight: Promise<void> | null = null
  private generation = 0

  constructor(options: ComposerOptions = {}) {
    this.load = options.load ?? fetchStatus
    this.freshMs = options.freshMs ?? COMPOSER_FRESH_MS
    this.now = options.now ?? (() => Date.now())
  }

  readonly getSnapshot = (): ComposerSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read only when the cached value is missing or older than the freshness window. */
  ensureFresh(): void {
    const age = this.snapshot.loadedAt === null ? Number.POSITIVE_INFINITY : this.now() - this.snapshot.loadedAt
    if (age < this.freshMs) return
    void this.read(false)
  }

  /** Manual refresh from the popover: ignores the freshness window. */
  async refresh(): Promise<void> {
    await this.read(true)
  }

  /** Drop in-memory state (used when a page teardown should force a re-read). */
  reset(): void {
    this.generation += 1
    this.inflight = null
    this.publish(EMPTY_COMPOSER)
  }

  private async read(manual: boolean): Promise<void> {
    if (this.inflight !== null) {
      await this.inflight
      return
    }
    const generation = this.generation
    if (manual) this.publish({ ...this.snapshot, refreshing: true, loading: this.snapshot.status === null })
    else if (this.snapshot.status === null) this.publish({ ...this.snapshot, loading: true })
    const task = (async (): Promise<void> => {
      try {
        const status = await this.load()
        if (generation !== this.generation) return
        this.publish({ status, loading: false, refreshing: false, error: null, loadedAt: this.now() })
      } catch (error) {
        if (generation !== this.generation) return
        this.publish({ ...this.snapshot, loading: false, refreshing: false, error: describeError(error) })
      }
    })()
    this.inflight = task
    try {
      await task
    } finally {
      if (this.inflight === task) this.inflight = null
    }
  }

  private publish(next: ComposerSnapshot): void {
    const previous = this.snapshot
    if (previous.status === next.status
      && previous.loading === next.loading
      && previous.refreshing === next.refreshing
      && previous.error === next.error
      && previous.loadedAt === next.loadedAt) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** The single composer readout cache shared by both registered seats. */
export const composerStatus = new ComposerStatusSource()
