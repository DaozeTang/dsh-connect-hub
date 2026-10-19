/**
 * Stored reasoning-effort observations, one record per account and model.
 *
 * A record is evidence about one catalog row, never a permanent capability
 * claim: it is consulted only for models that declare no effort set, it is
 * invalidated when the relevant catalog fields change, and it expires. Only
 * model ids, effort spellings, and timestamps are stored — never a token,
 * prompt, or response body.
 */

import { createHash } from 'node:crypto'
import type { PrefsStore } from '../../core/prefs.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyEffort } from './upstream.ts'

/** Persisted document schema; older shapes are discarded rather than migrated. */
const PROBE_SCHEMA = 2

/** Observation lifetime. Upstream metadata churns, so evidence must not live forever. */
const RECORD_TTL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * What a probe established about the model's effort parameter:
 * `validating` (unknown values are rejected, so per-level answers mean
 * something), `non-validating` (the value is accepted blindly), or `unknown`
 * (the run was indecisive — not a negative claim).
 */
export type WorkBuddyProbeValidation = 'validating' | 'non-validating' | 'unknown'

/** One model's recorded observation. */
export interface WorkBuddyProbeRecord {
  /** Fingerprint of the catalog row this observation was made against. */
  fingerprint: string
  validation: WorkBuddyProbeValidation
  /** Efforts verified as accepted; only ever non-empty for `validating`. */
  efforts: readonly WorkBuddyEffort[]
  /** When the probe ran, epoch milliseconds. */
  probedAtMs: number
  /** Plugin version that produced the record. */
  pluginVersion: string
  /** The account this observation was made under, as `uid:enterpriseId`. */
  account: string
}

/** Records grouped by account, then by model id. */
type RecordTable = Record<string, Record<string, WorkBuddyProbeRecord>>

interface ProbeDocument {
  version: typeof PROBE_SCHEMA
  records: RecordTable
}

const VALIDATION_VALUES: readonly WorkBuddyProbeValidation[] = ['validating', 'non-validating', 'unknown']

/** A non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A defined validation value. */
function isValidation(value: unknown): value is WorkBuddyProbeValidation {
  return typeof value === 'string' && (VALIDATION_VALUES as readonly string[]).includes(value)
}

/**
 * Fingerprint the catalog fields a probe depends on.
 *
 * Display-only fields (`name`, billing, context windows) are excluded so a
 * rename or promo change keeps a valid observation; the whole reasoning object
 * is included so any declared-shape change re-probes.
 */
export function fingerprintModel(info: WorkBuddyModelInfo): string {
  const basis = JSON.stringify({
    id: info.id,
    reasoning: info.reasoning ?? null,
    supportsImages: info.supportsImages ?? null,
  })
  return createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

/** One record's shape check; a bad row is dropped rather than trusted. */
export function isProbeRecord(value: unknown): value is WorkBuddyProbeRecord {
  if (!isRecord(value)) return false
  if (!isValidation(value['validation'])) return false
  if (typeof value['fingerprint'] !== 'string') return false
  if (typeof value['probedAtMs'] !== 'number' || !Number.isFinite(value['probedAtMs'])) return false
  if (typeof value['pluginVersion'] !== 'string') return false
  if (typeof value['account'] !== 'string' || value['account'] === '') return false
  const efforts = value['efforts']
  return Array.isArray(efforts) && efforts.every((effort) => typeof effort === 'string')
}

/** Options for {@link WorkBuddyProbeStore}. */
export interface WorkBuddyProbeStoreOptions {
  prefs: Pick<PrefsStore, 'get' | 'set'>
  key: string
  /** Observation lifetime; defaults to 14 days. */
  ttlMs?: number
  /** Plugin version stamped into new records. */
  pluginVersion: string
  /** Clock injection for tests. */
  now?: () => number
}

/** Decode one persisted document, dropping malformed accounts and records. */
function decodeRecords(stored: unknown): RecordTable {
  const table: RecordTable = {}
  if (!isRecord(stored) || stored['version'] !== PROBE_SCHEMA) return table
  const source = stored['records']
  if (!isRecord(source)) return table
  for (const [account, bucket] of Object.entries(source)) {
    if (!isRecord(bucket)) continue
    const accepted: Record<string, WorkBuddyProbeRecord> = {}
    for (const [modelId, record] of Object.entries(bucket)) {
      if (isProbeRecord(record)) accepted[modelId] = record
    }
    table[account] = accepted
  }
  return table
}

/**
 * Account-scoped observation records: loaded once, persisted through the shared
 * preferences store, and served only while fresh and matching the current
 * catalog row.
 */
export class WorkBuddyProbeStore {
  private readonly prefs: Pick<PrefsStore, 'get' | 'set'>
  private readonly key: string
  private readonly ttlMs: number
  private readonly pluginVersion: string
  private readonly clock: () => number
  private table: RecordTable | undefined

  constructor(options: WorkBuddyProbeStoreOptions) {
    this.prefs = options.prefs
    this.key = options.key
    this.ttlMs = options.ttlMs ?? RECORD_TTL_MS
    this.pluginVersion = options.pluginVersion
    this.clock = options.now ?? (() => Date.now())
  }

  /** Load the persisted document once; call before the first probe read. */
  async load(): Promise<void> {
    this.table = decodeRecords(await this.prefs.get<unknown>(this.key))
  }

  /**
   * The usable record for one account and model: fresh, taken against the same
   * catalog fingerprint, and belonging to the requesting account.
   */
  get(modelId: string, fingerprint: string, account: string): WorkBuddyProbeRecord | undefined {
    const record = this.table?.[account]?.[modelId]
    if (record === undefined) return undefined
    if (record.account !== account) return undefined
    if (record.fingerprint !== fingerprint) return undefined
    if (this.clock() - record.probedAtMs > this.ttlMs) return undefined
    return record
  }

  /**
   * Store one observation under the account stamped on it. A transient
   * `unknown` never replaces an existing decisive record for the same row.
   */
  async set(modelId: string, record: WorkBuddyProbeRecord): Promise<void> {
    const bucket = this.table?.[record.account] ?? {}
    const previous = bucket[modelId]
    const keepsDecisive =
      record.validation === 'unknown'
      && previous !== undefined
      && previous.validation !== 'unknown'
      && previous.fingerprint === record.fingerprint
    if (keepsDecisive) return
    const next: RecordTable = { ...(this.table ?? {}), [record.account]: { ...bucket, [modelId]: record } }
    this.table = next
    await this.persist(next)
  }

  /** Drop every record of every account. */
  async clear(): Promise<void> {
    this.table = {}
    await this.persist({})
  }

  /** Build a record stamped with this store's clock, version, and account. */
  record(
    fingerprint: string,
    validation: WorkBuddyProbeValidation,
    efforts: readonly WorkBuddyEffort[],
    account: string,
  ): WorkBuddyProbeRecord {
    return {
      fingerprint,
      validation,
      // A run that did not validate the parameter cannot support levels.
      efforts: validation === 'validating' ? [...efforts] : [],
      probedAtMs: this.clock(),
      pluginVersion: this.pluginVersion,
      account,
    }
  }

  private async persist(records: RecordTable): Promise<void> {
    try {
      const document: ProbeDocument = { version: PROBE_SCHEMA, records }
      await this.prefs.set(this.key, document)
    } catch {
      // Losing the memory of an observation must never take the provider down.
    }
  }
}
