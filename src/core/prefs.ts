import { readJsonFile, writeJsonFile } from './atomic.ts'
import type { HubLogger } from './log.ts'
import type { HubPaths } from './paths.ts'

interface PrefsDocument {
  version: 1
  values: Record<string, unknown>
}

const FILENAME = 'preferences.json'

export class PrefsStore {
  private document: PrefsDocument | undefined
  private flushTimer: NodeJS.Timeout | undefined
  private writing: Promise<void> = Promise.resolve()
  private readonly path: string
  private readonly log: HubLogger
  private dirty = false

  constructor(paths: HubPaths, log: HubLogger) {
    this.path = `${paths.dataDir}/${FILENAME}`
    this.log = log.child('prefs')
  }

  async load(): Promise<void> {
    const stored = await readJsonFile<PrefsDocument>(this.path)
    this.document = stored !== undefined && stored.version === 1 && typeof stored.values === 'object' && stored.values !== null
      ? stored
      : { version: 1, values: {} }
  }

  private async ready(): Promise<PrefsDocument> {
    if (this.document === undefined) await this.load()
    return this.document as PrefsDocument
  }

  async get<T>(key: string): Promise<T | undefined> {
    const document = await this.ready()
    return document.values[key] as T | undefined
  }

  async set<T>(key: string, value: T): Promise<void> {
    const document = await this.ready()
    document.values[key] = value
    this.scheduleFlush()
  }

  async patch<T extends Record<string, unknown>>(key: string, patch: Partial<T>): Promise<T> {
    const document = await this.ready()
    const current = (document.values[key] ?? {}) as T
    const next = { ...current, ...patch }
    document.values[key] = next
    this.scheduleFlush()
    return next
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, 150)
    this.flushTimer.unref?.()
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const document = await this.ready()
    this.writing = this.writing.then(async () => {
      try {
        await writeJsonFile(this.path, document)
      } catch (error) {
        this.dirty = true
        this.log.error(`cannot persist preferences: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    await this.writing
  }

  async dispose(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    await this.flush()
  }
}
