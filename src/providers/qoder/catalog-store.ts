import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../../core/atomic.ts'
import type { HubLogger } from '../../core/log.ts'
import type { HubPaths } from '../../core/paths.ts'
import type { QoderRegion } from './qoder/region.ts'
import type { QoderModelBilling, QoderModelInfo, QoderModelReasoning } from './catalog.ts'

const DOCUMENT_VERSION = 1
const FILE_PREFIX = '.qoder-catalog-'

/** One region's last served catalog, keyed by the account that fetched it. */
interface SavedCatalog {
  account: string
  fetchedAtMs: number
  models: QoderModelInfo[]
}

interface CatalogDocument {
  version: typeof DOCUMENT_VERSION
  entries: Record<string, SavedCatalog>
}

export interface QoderCatalogStoreOptions {
  paths: HubPaths
  region: QoderRegion
  log: HubLogger
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Read one row's reasoning block; absent or unsupported means "no control". */
function reasoningOf(value: unknown): QoderModelReasoning | undefined {
  const row = plainObject(value)
  if (row === undefined || row['supports'] !== true) return undefined
  const efforts = Array.isArray(row['supportedEfforts'])
    ? row['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : []
  const defaultEffort = trimmedString(row['defaultEffort'])
  return {
    supports: true,
    ...efforts.length === 0 ? {} : { supportedEfforts: efforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    canDisableThinking: row['canDisableThinking'] === true,
  }
}

/** Read one row's billing block; an unreadable block reads as "rate unknown". */
function billingOf(value: unknown): QoderModelBilling {
  const row = plainObject(value)
  if (row === undefined) return { free: false, rateUnknown: true }
  const credits = trimmedString(row['credits'])
  return {
    ...credits === undefined ? {} : { credits },
    free: row['free'] === true,
    ...row['rateUnknown'] === true ? { rateUnknown: true } : {},
  }
}

/** Read one stored model row, or undefined when a required field is unusable. */
function modelRowOf(value: unknown): QoderModelInfo | undefined {
  const row = plainObject(value)
  if (row === undefined) return undefined
  const id = trimmedString(row['id'])
  const name = trimmedString(row['name'])
  const contextWindow = positiveNumber(row['contextWindow'])
  const maxTokens = positiveNumber(row['maxTokens'])
  if (id === undefined || name === undefined) return undefined
  if (contextWindow === undefined || maxTokens === undefined) return undefined
  if (typeof row['supportsImages'] !== 'boolean') return undefined

  const declaredWindows = Array.isArray(row['supportedContextWindows'])
    ? row['supportedContextWindows'].filter((entry): entry is number => positiveNumber(entry) !== undefined)
    : []
  const defaultContextWindow = positiveNumber(row['defaultContextWindow'])
  const reasoning = reasoningOf(row['reasoning'])
  const source = trimmedString(row['source'])
  return {
    id,
    name,
    contextWindow,
    ...defaultContextWindow === undefined ? {} : { defaultContextWindow },
    ...declaredWindows.length === 0 ? {} : { supportedContextWindows: declaredWindows },
    maxTokens,
    supportsImages: row['supportsImages'],
    ...reasoning === undefined ? {} : { reasoning },
    billing: billingOf(row['billing']),
    ...source === undefined ? {} : { source },
  }
}

/** Read one account's saved catalog; a row with no usable model is discarded. */
function savedCatalogOf(value: unknown): SavedCatalog | undefined {
  const entry = plainObject(value)
  if (entry === undefined) return undefined
  const account = typeof entry['account'] === 'string' && entry['account'] !== '' ? entry['account'] : undefined
  const fetchedAtMs = entry['fetchedAtMs']
  if (account === undefined) return undefined
  if (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs)) return undefined
  if (!Array.isArray(entry['models'])) return undefined
  const models = entry['models']
    .map(modelRowOf)
    .filter((model): model is QoderModelInfo => model !== undefined)
  if (models.length === 0) return undefined
  return { account, fetchedAtMs, models }
}

/**
 * The last catalog each account was actually served, per region.
 *
 * This is a rebuildable cache used only when a fresh fetch cannot answer. The
 * regions are stored separately because their rates, windows and even model ids
 * differ. The account key is a one-way hash of the credential; no token is
 * stored here.
 */
export class QoderCatalogStore {
  private readonly file: string
  private readonly log: HubLogger
  private readonly entries = new Map<string, SavedCatalog>()
  private loaded = false

  constructor(options: QoderCatalogStoreOptions) {
    this.file = join(options.paths.stateDir, `${FILE_PREFIX}${options.region}.json`)
    this.log = options.log.child('catalog-store')
  }

  /** Absolute path of the state file, for diagnostics and tests. */
  filePath(): string {
    return this.file
  }

  /** Read the persisted document once; malformed content reads as empty. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const stored = await readJsonFile<unknown>(this.file)
    const document = plainObject(stored)
    if (document === undefined || document['version'] !== DOCUMENT_VERSION) return
    const entries = document['entries']
    if (typeof entries !== 'object' || entries === null) return
    for (const [account, value] of Object.entries(entries)) {
      const saved = savedCatalogOf(value)
      if (saved !== undefined) this.entries.set(account, saved)
    }
  }

  /** This region's saved catalog for one account. */
  get(account: string): SavedCatalog | undefined {
    return this.entries.get(account)
  }

  /** Remember one account's catalog and schedule a persist of the document. */
  set(account: string, catalog: Omit<SavedCatalog, 'account'>): void {
    this.entries.set(account, { account, fetchedAtMs: catalog.fetchedAtMs, models: catalog.models })
    void this.persist()
  }

  /** Forget one account's catalog when that account signs out. */
  delete(account: string): void {
    if (!this.entries.delete(account)) return
    void this.persist()
  }

  /** Flush pending state; called from dispose so a write is not lost. */
  async flush(): Promise<void> {
    await this.persist()
  }

  private async persist(): Promise<void> {
    const entries: Record<string, SavedCatalog> = {}
    for (const [account, saved] of this.entries) entries[account] = saved
    try {
      await writeJsonFile(this.file, { version: DOCUMENT_VERSION, entries } satisfies CatalogDocument)
    } catch (error) {
      // The served catalog never depends on this cache write.
      this.log.warn(`保存模型目录缓存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
