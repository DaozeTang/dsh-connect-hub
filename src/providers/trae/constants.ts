import type { BilingualText, ProviderId } from '../../shared/contracts.ts'
import type { SecretSlot } from '../../core/vault.ts'
import type { TraeEdition } from './paths.ts'
import type { TraeRegion } from './region.ts'

/**
 * Fixed facts about the two Trae routes this provider owns: ids and labels the
 * hub addresses them by, the vault slot holding each region's refreshed
 * credentials, and the defaults its background work runs with.
 */

const ROUTE_IDS: Readonly<Record<TraeRegion, ProviderId>> = {
  cn: 'trae',
  ai: 'trae-global',
}

const ROUTE_NAMES: Readonly<Record<TraeRegion, string>> = {
  cn: 'Trae',
  ai: 'Trae Global',
}

const ROUTE_LABELS: Readonly<Record<TraeRegion, BilingualText>> = {
  cn: { zh: 'Trae', en: 'Trae' },
  ai: { zh: 'Trae 国际版', en: 'Trae Global' },
}

const VAULT_SLOTS: Readonly<Record<TraeRegion, SecretSlot>> = {
  cn: 'trae-cn',
  ai: 'trae-global',
}

const CHECKIN_DEFAULTS = {
  /** 09:00 in UTC+8, expressed as a minute of day. */
  minute: 9 * 60,
  /** Retained log rows, newest last. */
  logLimit: 30,
  /** Trae business code meaning this device already used today's claim. */
  deviceClaimedCode: 9095,
} as const

const LOOP_DEFAULTS = {
  /** How often cached usage is refreshed in the background. */
  usageIntervalMs: 5 * 60_000,
  /** How many other accounts one usage refresh may read. */
  accountReadLimit: 8,
} as const

const PROBE_DEFAULTS = {
  /** Upper bound on models one explicit availability test may probe. */
  modelsPerRun: 64,
} as const

/** Provider route ids owned by this family, per region. */
export const TRAE_PROVIDER_IDS = ROUTE_IDS
/** Provider route display names, as offered to the harness model picker. */
export const TRAE_PROVIDER_DISPLAY_NAMES = ROUTE_NAMES
/** Bilingual labels for the hub settings page. */
export const TRAE_PROVIDER_LABELS = ROUTE_LABELS
/** Vault slot holding one region's provider-owned credential copies. */
export const TRAE_VAULT_SLOTS = VAULT_SLOTS
/** Pinned settings namespace for the configurable-provider directory entry. */
export const TRAE_SETTINGS_NS = 'dsh-connect-hub'
/** Period between cached usage refreshes. */
export const TRAE_USAGE_REFRESH_INTERVAL_MS = LOOP_DEFAULTS.usageIntervalMs
/** Default daily check-in time, as a UTC+8 minute of day. */
export const TRAE_DEFAULT_CHECKIN_MINUTE = CHECKIN_DEFAULTS.minute
/** Maximum number of check-in log rows kept in preferences. */
export const TRAE_CHECKIN_LOG_LIMIT = CHECKIN_DEFAULTS.logLimit
/** Maximum number of other accounts one usage refresh may read. */
export const TRAE_ACCOUNT_READ_LIMIT = LOOP_DEFAULTS.accountReadLimit
/** Trae business code for "this device already used today's check-in". */
export const TRAE_CHECKIN_DEVICE_CLAIMED_CODE = CHECKIN_DEFAULTS.deviceClaimedCode
/** Maximum number of models one explicit availability test may probe. */
export const TRAE_MODELS_TEST_LIMIT = PROBE_DEFAULTS.modelsPerRun

/** Human-readable edition label shown in the account table. */
export const TRAE_EDITION_LABELS: Readonly<Record<TraeEdition, string>> = {
  cn: '国内桌面版',
  sg: '国际桌面版',
  solo: 'SOLO 国内版',
  'solo-sg': 'SOLO 国际版',
}
