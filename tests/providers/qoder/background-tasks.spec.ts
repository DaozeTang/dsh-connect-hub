/**
 * background work started by the Qoder provider (init,
 * credential sweep, check-in, save-secret) must never escape as an unhandled
 * rejection — Node terminates the host process on those. Failures are expected
 * to be logged (redacted) and, where user-visible, reflected in status().
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createQoderProviders } from '../../../src/providers/qoder/index.ts'
import { runBackgroundTask } from '../../../src/providers/qoder/provider.ts'
import { harness } from './host.ts'
import type { HubLogger } from '../../../src/core/log.ts'

interface RejectionCapture {
  rejections: unknown[]
  restore(): void
}

function captureRejections(): RejectionCapture {
  const rejections: unknown[] = []
  const listener = (reason: unknown): void => { rejections.push(reason) }
  process.on('unhandledRejection', listener)
  return {
    rejections,
    restore: () => { process.off('unhandledRejection', listener) },
  }
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 25))
}

interface RecordingLogger extends HubLogger {
  warnings: string[]
}

function recordingLogger(): RecordingLogger {
  const warnings: string[] = []
  const log: RecordingLogger = {
    warnings,
    info: () => {},
    warn: (message: string) => { warnings.push(message) },
    error: () => {},
    child: () => log,
  }
  return log
}

let cleanup: string | undefined
afterEach(async () => {
  if (cleanup !== undefined) {
    await rm(cleanup, { recursive: true, force: true })
    cleanup = undefined
  }
})

describe('runBackgroundTask', () => {
  it('absorbs a rejecting task: logs a redacted warning, reports once, no unhandled rejection', async () => {
    const capture = captureRejections()
    try {
      const log = recordingLogger()
      const reported: unknown[] = []
      runBackgroundTask({
        label: 'Qoder',
        log,
        work: async () => {
          throw new Error('vault read failed (Authorization: Bearer abcdefghijklmnop)')
        },
        onError: error => { reported.push(error) },
      })
      await settle()
      expect(capture.rejections).toEqual([])
      expect(reported).toHaveLength(1)
      expect(log.warnings.join('\n')).toContain('后台任务失败')
      expect(log.warnings.join('\n')).not.toContain('abcdefghijklmnop')
    } finally {
      capture.restore()
    }
  })

  it('absorbs a synchronously throwing task as well', async () => {
    const capture = captureRejections()
    try {
      let reported = 0
      runBackgroundTask({
        label: 'Qoder',
        log: recordingLogger(),
        // Deliberately throws before producing a promise.
        work: (() => { throw new Error('sync boom') }) as () => Promise<void>,
        onError: () => { reported += 1 },
      })
      await settle()
      expect(capture.rejections).toEqual([])
      expect(reported).toBe(1)
    } finally {
      capture.restore()
    }
  })

  it('does not let a throwing onError handler resurrect the rejection', async () => {
    const capture = captureRejections()
    try {
      runBackgroundTask({
        label: 'Qoder',
        log: recordingLogger(),
        work: async () => { throw new Error('task failed') },
        onError: () => { throw new Error('reporting failed') },
      })
      await settle()
      expect(capture.rejections).toEqual([])
    } finally {
      capture.restore()
    }
  })
})

/** Internals the regression test drives to reach the real background call sites. */
interface ProviderInternals {
  store: {
    reload(): Promise<{ pat: string; savedAtMs: number } | undefined>
    identity(): string | undefined
    load(): Promise<unknown>
    current(): unknown
    summary(): { configured: boolean }
  }
  syncCredentials(): Promise<void>
  runInBackground(kind: 'catalog' | 'usage' | 'checkin', work: () => Promise<void>): void
}

describe('Qoder provider background refreshes', () => {
  it('survives a credentials-service failure during a credential sweep without an unhandled rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-background-'))
    cleanup = root
    const hosted = harness(root)
    const runtime = createQoderProviders(hosted.deps)[0]!
    await runtime.init()
    const capture = captureRejections()
    try {
      const internals = runtime as unknown as ProviderInternals
      // Simulate a credential added outside the plugin whose vault reads now
      // fail: the sweep adopts it, then both background refreshes hit the
      // failing credential read.
      internals.store.reload = async () => ({ pat: 'external-pat', savedAtMs: 1 })
      internals.store.identity = () => 'pat:external'
      internals.store.load = async () => {
        throw new Error('credentials service unavailable (Authorization: Bearer abcdefghijklmnop)')
      }
      await internals.syncCredentials()
      await settle()
      expect(capture.rejections).toEqual([])

      const status = runtime.status()
      expect(['needs-credential', 'error']).toContain(status.state)
      const codes = status.warnings.map(warning => warning.code)
      expect(codes).toContain('catalog-unavailable')
      expect(codes).toContain('usage-unavailable')
      // The redaction contract still holds on the new error surface.
      expect(JSON.stringify(status)).not.toContain('abcdefghijklmnop')
    } finally {
      capture.restore()
      await runtime.dispose()
    }
  })

  it('absorbs an unexpected rejection from a refresh started through the provider helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-background-'))
    cleanup = root
    const hosted = harness(root)
    const runtime = createQoderProviders(hosted.deps)[0]!
    await runtime.init()
    const capture = captureRejections()
    try {
      const internals = runtime as unknown as ProviderInternals
      internals.runInBackground('catalog', async () => {
        throw new Error('unexpected background fault')
      })
      await settle()
      expect(capture.rejections).toEqual([])
      // Status remains readable and reports the failure as a warning.
      const status = runtime.status()
      expect(status.warnings.map(warning => warning.code)).toContain('catalog-unavailable')
      expect(() => JSON.stringify(status)).not.toThrow()
    } finally {
      capture.restore()
      await runtime.dispose()
    }
  })
})
