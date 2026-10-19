import type { TransferExport, TransferPreview, TransferPreviewRow } from '../../shared/contracts.ts'
import type { TraeCredential } from './auth.ts'
import { maskAccountName } from './errors.ts'
import {
  credentialOfTransferRecord,
  parseTransferFile,
  regionOfTransferRecord,
  traeTransferRecordOf,
  type TraeTransferRecord,
} from './transfer.ts'
import type { TraeRegion } from './region.ts'

/**
 * The hub-facing half of account transfer: a desensitized preview the page can
 * render, the id translation between preview rows and file positions, and the
 * explicit export payload. Only the export function ever returns tokens.
 */

const ROW_ID_PREFIX = 'account:'

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Label candidates in display order; identifiers are masked before rendering. */
function previewLabel(record: TraeTransferRecord, index: number): string {
  for (const key of ['nickname', 'email', 'uid'] as const) {
    const candidate = text(record[key])
    if (candidate !== '') return maskAccountName(candidate)
  }
  return `#${String(index + 1)}`
}

function regionLabel(record: TraeTransferRecord): TransferPreviewRow['region'] {
  const region = regionOfTransferRecord(record)
  if (region === 'ai') return 'global'
  if (region === 'cn') return 'cn'
  return 'unknown'
}

function tokenPresent(record: TraeTransferRecord): boolean {
  const token: unknown = record['access_token']
  return typeof token === 'string' && token !== ''
}

/**
 * Desensitized preview: labels, a positively identified region, and whether a
 * token is present. `skipped` counts records the importer will reject (missing
 * token, or a host that is not a known HTTPS gateway for the claimed region).
 */
export function previewTransferOf(fileText: string): TransferPreview {
  const records = parseTransferFile(fileText)
  const skipped = records.filter(record => credentialOfTransferRecord(record) === undefined).length
  const rows = records.map((record, index): TransferPreviewRow => ({
    id: `${ROW_ID_PREFIX}${String(index)}`,
    label: previewLabel(record, index),
    region: regionLabel(record),
    hasToken: tokenPresent(record),
  }))
  return { rows, skipped }
}

/** Translate selected preview ids back into in-range, deduplicated file positions. */
export function transferIndexesOf(accountIds: readonly string[], recordCount: number): number[] {
  const indexes: number[] = []
  for (const id of accountIds) {
    if (!id.startsWith(ROW_ID_PREFIX)) continue
    const index = Number(id.slice(ROW_ID_PREFIX.length))
    if (!Number.isInteger(index) || index < 0 || index >= recordCount) continue
    if (!indexes.includes(index)) indexes.push(index)
  }
  return indexes
}

/** The original auth document exported verbatim for the write-back path. */
export function traeAuthRawOf(credential: TraeCredential): unknown {
  const expiresAt = credential.expiresAtMs > 0 ? Math.floor(credential.expiresAtMs / 1000) : 0
  return {
    auth: {
      accessToken: credential.accessToken,
      ...credential.refreshToken === undefined ? {} : { refreshToken: credential.refreshToken },
      expiresAt,
      ...credential.refreshExpiresAtMs === undefined
        ? {}
        : { refreshExpiresAt: Math.floor(credential.refreshExpiresAtMs / 1000) },
      host: credential.host,
      ...credential.userRegion === undefined ? {} : { userRegion: credential.userRegion },
    },
    account: {
      userId: credential.userId,
      ...credential.accountName === undefined ? {} : { username: credential.accountName },
      edition: credential.edition,
    },
  }
}

/** The explicit-export payload for the selected accounts of one region. */
export function transferExportOf(
  region: TraeRegion,
  credentials: readonly TraeCredential[],
): TransferExport {
  const records = credentials.map(credential => traeTransferRecordOf(credential, traeAuthRawOf(credential)))
  return {
    fileName: `trae-${region === 'ai' ? 'global' : 'cn'}-accounts.json`,
    content: `${JSON.stringify(records, null, 2)}\n`,
  }
}
