/**
 * The last catalog that actually loaded, per variant and per account.
 *
 * The built-in roster is a one-off snapshot; a fetched catalog is what the
 * upstream actually served this account. The store never prevents a fetch — it
 * only answers when a fetch cannot — and it is never shared across accounts or
 * variants. It holds model metadata only, never a token.
 */

import type { PrefsStore } from '../../core/prefs.ts'
import type { WorkBuddyUpstreamModel } from './upstream.ts'

/** Persisted document schema this reader accepts. */
const CATALOG_SCHEMA = 1

/** One saved catalog: the account it belonged to, and the models it listed. */
export interface SavedCatalog {
  /** `uid:enterpriseId` the catalog was fetched for. */
  account: string
  /** Which document answered, so a CN roster is never served as an AI one. */
  source: string
  /** When the fetch succeeded, epoch milliseconds. */
  fetchedAtMs: number
  models: readonly WorkBuddyUpstreamModel[]
  /** App version used as the UA, when the variant needed one. */
  appVersion?: string
}

/** The full persisted document. */
interface CatalogDocument {
  version: typeof CATALOG_SCHEMA
  entries: Record<string, SavedCatalog>
}

/** A non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-empty string check. */
function isName(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Finite number check. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Whether a parsed value is a model row worth keeping. */
export function isSavedCatalogModel(value: unknown): value is WorkBuddyUpstreamModel {
  if (!isRecord(value)) return false
  return (
    isName(value['id'])
    && typeof value['name'] === 'string'
    && isFiniteNumber(value['contextWindow'])
    && isFiniteNumber(value['maxTokens'])
    && typeof value['supportsImages'] === 'boolean'
  )
}

/** Whether a parsed value is a saved catalog this reader can trust. */
export function isSavedCatalog(value: unknown): value is SavedCatalog {
  if (!isRecord(value)) return false
  if (!isName(value['account']) || !isName(value['source'])) return false
  if (!isFiniteNumber(value['fetchedAtMs'])) return false
  const models = value['models']
  return Array.isArray(models) && models.length > 0 && models.every(isSavedCatalogModel)
}

/** Decode one persisted document into an entries map, dropping bad rows. */
function decodeEntries(stored: unknown): Record<string, SavedCatalog> {
  const entries: Record<string, SavedCatalog> = {}
  if (!isRecord(stored) || stored['version'] !== CATALOG_SCHEMA) return entries
  const source = stored['entries']
  if (!isRecord(source)) return entries
  for (const [account, entry] of Object.entries(source)) {
    if (isSavedCatalog(entry)) entries[account] = entry
  }
  return entries
}

/**
 * Last successful catalog per account. Malformed content reads as "nothing
 * saved": this state only powers the offline and first-seconds cases, so a
 * corrupt document must never stop the route from serving models.
 */
export class WorkBuddyCatalogStore {
  private readonly prefs: Pick<PrefsStore, 'get' | 'set'>
  private readonly key: string
  private table: Record<string, SavedCatalog> | undefined

  constructor(prefs: Pick<PrefsStore, 'get' | 'set'>, key: string) {
    this.prefs = prefs
    this.key = key
  }

  /** Load the persisted document once; call before the first status read. */
  async load(): Promise<void> {
    this.table = decodeEntries(await this.prefs.get<unknown>(this.key))
  }

  /** The saved catalog for one account, or `undefined` when there is none. */
  get(account: string): SavedCatalog | undefined {
    return this.table?.[account]
  }

  /** Remember a catalog for an account, replacing whatever was saved before. */
  async set(account: string, catalog: Omit<SavedCatalog, 'account'>): Promise<void> {
    const next = { ...(this.table ?? {}), [account]: { account, ...catalog } }
    this.table = next
    await this.persist(next)
  }

  /** Forget one account's catalog — used when that account signs out. */
  async delete(account: string): Promise<void> {
    if (this.table === undefined || !(account in this.table)) return
    const next = { ...this.table }
    delete next[account]
    this.table = next
    await this.persist(next)
  }

  private async persist(entries: Record<string, SavedCatalog>): Promise<void> {
    const document: CatalogDocument = { version: CATALOG_SCHEMA, entries }
    try {
      await this.prefs.set(this.key, document)
    } catch {
      // The served catalog does not depend on this write.
    }
  }
}
