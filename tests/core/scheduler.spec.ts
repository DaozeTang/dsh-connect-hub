import { describe, expect, it, vi } from 'vitest'
import { SingleFlight, Scheduler, nextUtc8Occurrence } from '../../src/core/scheduler.ts'

function silentLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log }
  return log
}

describe('UTC+8 clock helpers', () => {
  it('schedules the next occurrence in the future', () => {
    const now = Date.UTC(2026, 0, 1, 2, 0)
    expect(nextUtc8Occurrence(600, now) - now).toBe(0)
    const earlier = Date.UTC(2026, 0, 1, 1, 0)
    expect(nextUtc8Occurrence(600, earlier) - earlier).toBe(60 * 60 * 1000)
    const later = Date.UTC(2026, 0, 1, 3, 0)
    expect(nextUtc8Occurrence(600, later) - later).toBe(23 * 60 * 60 * 1000)
  })
})

describe('Scheduler', () => {
  it('runs and clears tracked timers', async () => {
    vi.useFakeTimers()
    try {
      const scheduler = new Scheduler(silentLog() as never)
      const run = vi.fn()
      scheduler.setTimeout('once', 100, run)
      await vi.advanceTimersByTimeAsync(50)
      expect(run).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60)
      expect(run).toHaveBeenCalledTimes(1)
      scheduler.setTimeout('cleared', 100, run)
      scheduler.clear('cleared')
      await vi.advanceTimersByTimeAsync(200)
      expect(run).toHaveBeenCalledTimes(1)
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Scheduler.atUtc8Minute', () => {
  it('reschedules after a rejecting job instead of disabling the daily run', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-18T01:00:30Z')) // 09:00:30 UTC+8
      const log = silentLog()
      const scheduler = new Scheduler(log as never)
      let calls = 0
      scheduler.atUtc8Minute('daily', 600, () => {
        calls += 1
        throw new Error('scheduled work failed')
      })
      // 10:00 UTC+8 today.
      await vi.advanceTimersByTimeAsync(59 * 60 * 1000 + 30 * 1000)
      expect(calls).toBe(1)
      expect(log.warn).toHaveBeenCalledTimes(1)
      // The failure must not drop the next day's registration.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(calls).toBe(2)
      scheduler.dispose()
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SingleFlight', () => {
  it('shares one in-flight promise', async () => {
    const flight = new SingleFlight<number>()
    let calls = 0
    let release: (value: number) => void = () => {}
    const first = flight.run(() => {
      calls += 1
      return new Promise<number>((resolve) => { release = resolve })
    })
    const second = flight.run(() => {
      calls += 1
      return Promise.resolve(2)
    })
    expect(calls).toBe(1)
    release(1)
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(await flight.run(() => Promise.resolve(3))).toBe(3)
  })
})
