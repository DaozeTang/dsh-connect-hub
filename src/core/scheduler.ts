import type { HubLogger } from './log.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function utc8Now(now = Date.now()): Date {
  return new Date(now + 8 * 60 * 60 * 1000)
}

export function nextUtc8Occurrence(minute: number, now = Date.now()): number {
  const current = utc8Now(now)
  const occurrence = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
    Math.floor(minute / 60),
    minute % 60,
    0,
    0,
  ) - 8 * 60 * 60 * 1000
  return occurrence >= now ? occurrence : occurrence + DAY_MS
}

export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly log: HubLogger
  private disposed = false

  constructor(log: HubLogger) {
    this.log = log.child('scheduler')
  }

  every(name: string, intervalMs: number, run: () => Promise<void> | void): void {
    this.clear(name)
    if (this.disposed) return
    const tick = (): void => {
      void Promise.resolve()
        .then(run)
        .catch((error: unknown) => this.log.warn(`${name} failed: ${error instanceof Error ? error.message : String(error)}`))
    }
    const timer = setInterval(tick, Math.max(1000, intervalMs))
    timer.unref?.()
    this.timers.set(name, timer)
  }

  setTimeout(name: string, delayMs: number, run: () => Promise<void> | void): void {
    this.clear(name)
    if (this.disposed) return
    const timer = setTimeout(() => {
      this.timers.delete(name)
      void Promise.resolve()
        .then(run)
        .catch((error: unknown) => this.log.warn(`${name} failed: ${error instanceof Error ? error.message : String(error)}`))
    }, Math.max(0, delayMs))
    timer.unref?.()
    this.timers.set(name, timer)
  }

  atUtc8Minute(name: string, minute: number, run: () => Promise<void> | void): void {
    // A reschedule that lands exactly on the occurrence minute must wait for
    // the NEXT day, never fire a second time in the same instant.
    const now = Date.now()
    const occurrence = nextUtc8Occurrence(minute, now)
    const delay = occurrence > now ? occurrence - now : 24 * 60 * 60 * 1000
    this.setTimeout(name, delay, async () => {
      // Reschedule in `finally`: a job that rejects must not silently disable
      // this provider's daily schedule until the next plugin restart.
      try {
        await run()
      } finally {
        if (!this.disposed) this.atUtc8Minute(name, minute, run)
      }
    })
  }

  clear(name: string): void {
    const timer = this.timers.get(name)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(name)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

export class SingleFlight<T> {
  private current: Promise<T> | undefined

  run(task: () => Promise<T>): Promise<T> {
    if (this.current !== undefined) return this.current
    this.current = task().finally(() => { this.current = undefined })
    return this.current
  }
}
