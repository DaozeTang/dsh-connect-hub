/**
 * Per-account model visibility: the model ids a signed-in account has hidden
 * from the harness picker.
 *
 * The persisted state is a disabled list rather than an enabled whitelist, so a
 * new account and any model the upstream adds start visible, and a hidden id
 * that briefly leaves the catalog is remembered. One store exists per variant,
 * keyed by the same `uid:enterpriseId` identity the saved catalogs use. Only
 * model-id strings are stored — never a token.
 */

import type { PrefsStore } from '../../core/prefs.ts'

/** Persisted document schema this reader accepts. */
const VISIBILITY_SCHEMA = 1

/** One account's saved preferences. */
export interface SavedVisibility {
  /** `uid:enterpriseId` the preferences belong to. */
  account: string
  /** Model ids hidden from this account's picker; never auto-pruned. */
  disabled: readonly string[]
  /** When this account's list last changed, epoch milliseconds. */
  updatedAtMs: number
}

/** The full persisted document. */
interface VisibilityDocument {
  version: typeof VISIBILITY_SCHEMA
  accounts: Record<string, SavedVisibility>
}

/** A non-array object, the only shape every persisted section uses. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-empty string check shared by the account and model-id fields. */
function isName(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Whether a parsed value is a saved preference entry this reader can trust. */
export function isSavedVisibility(value: unknown): value is SavedVisibility {
  if (!isRecord(value)) return false
  if (!isName(value['account'])) return false
  const updatedAtMs = value['updatedAtMs']
  if (typeof updatedAtMs !== 'number' || !Number.isFinite(updatedAtMs)) return false
  const disabled = value['disabled']
  return Array.isArray(disabled) && disabled.every(isName)
}

/** Decode one persisted document into the accounts map, dropping bad rows. */
function decodeAccounts(stored: unknown): Record<string, SavedVisibility> {
  const accounts: Record<string, SavedVisibility> = {}
  if (!isRecord(stored) || stored['version'] !== VISIBILITY_SCHEMA) return accounts
  const source = stored['accounts']
  if (!isRecord(source)) return accounts
  for (const [account, entry] of Object.entries(source)) {
    if (isSavedVisibility(entry)) accounts[account] = entry
  }
  return accounts
}

/** Apply one show/hide request to a list of hidden ids. */
function toggleHidden(hidden: readonly string[], model: string, visible: boolean): string[] {
  if (visible) return hidden.filter((id) => id !== model)
  return [...new Set([...hidden, model])]
}

/**
 * Per-account hidden-model lists, loaded once into memory and persisted through
 * the shared preferences store. A failed write propagates (the caller reports a
 * preference that did not persist); a corrupt document reads as "nothing
 * hidden".
 */
export class WorkBuddyVisibilityStore {
  private readonly prefs: Pick<PrefsStore, 'get' | 'set'>
  private readonly key: string
  private table: Record<string, SavedVisibility> | undefined

  constructor(prefs: Pick<PrefsStore, 'get' | 'set'>, key: string) {
    this.prefs = prefs
    this.key = key
  }

  /** Load the persisted document once; call before the first status read. */
  async load(): Promise<void> {
    this.table = decodeAccounts(await this.prefs.get<unknown>(this.key))
  }

  /** The model ids one account has hidden; empty when it never hid any. */
  disabled(account: string): readonly string[] {
    return this.table?.[account]?.disabled ?? []
  }

  /**
   * Show or hide one model for one account, persisting before committing.
   * Re-enabling the last hidden model removes the account entry outright.
   * Throws when the write fails, leaving the in-memory state untouched.
   */
  async setVisible(account: string, model: string, visible: boolean): Promise<void> {
    const hidden = toggleHidden(this.disabled(account), model, visible)
    const next = { ...(this.table ?? {}) }
    if (hidden.length === 0) delete next[account]
    else next[account] = { account, disabled: hidden, updatedAtMs: Date.now() }
    await this.persist(next)
    this.table = next
  }

  /** Current lists, for diagnostics and tests. */
  snapshot(): Readonly<Record<string, SavedVisibility>> {
    return { ...(this.table ?? {}) }
  }

  private async persist(accounts: Record<string, SavedVisibility>): Promise<void> {
    const document: VisibilityDocument = { version: VISIBILITY_SCHEMA, accounts }
    await this.prefs.set(this.key, document)
  }
}
