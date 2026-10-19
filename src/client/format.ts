/**
 * Pure presentation helpers for the Connect Hub client. Everything here is
 * deterministic given its inputs (no clock reads, no DOM, no network) so the
 * render tests can pin the exact strings and the components only map values.
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AccountView,
  CheckinLogRow,
  CheckinView,
  CreditsPackage,
  CreditsView,
  HostMessageParams,
  HubModel,
  HubStatus,
  ProviderFamily,
  ProviderId,
  ProviderStatus,
  Region,
  WarningView,
} from '../shared/contracts.ts'
import { FAMILIES, PROVIDER_IDS } from '../shared/contracts.ts'
import type { ConnectHubKey } from './locales.ts'

/** Translate seat of this feature's dictionary. */
export type ConnectHubTranslate = TranslateNS<'settings.connectHub'>

const PROVIDER_FAMILY: Record<ProviderId, ProviderFamily> = {
  qoder: 'qoder',
  'qoder-global': 'qoder',
  workbuddy: 'workbuddy',
  'workbuddy-ai': 'workbuddy',
  trae: 'trae',
  'trae-global': 'trae',
}

const PROVIDER_REGION: Record<ProviderId, Region> = {
  qoder: 'cn',
  'qoder-global': 'global',
  workbuddy: 'cn',
  'workbuddy-ai': 'global',
  trae: 'cn',
  'trae-global': 'global',
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value)
}

export function familyOfProvider(id: ProviderId): ProviderFamily {
  return PROVIDER_FAMILY[id]
}

/** Resolve the provider a family shows in one region. */
export function providerIdOf(family: ProviderFamily, region: Region): ProviderId {
  const providers = FAMILIES.find((entry) => entry.id === family)?.providers ?? []
  const found = providers.find((id) => PROVIDER_REGION[id] === region)
  // Every family ships both regions; keep a total function for future families.
  return found ?? providers[0] ?? 'qoder'
}

/** Brand name of one provider, without the region suffix. */
export function familyLabelOf(family: ProviderFamily): string {
  return FAMILIES.find((entry) => entry.id === family)?.label.zh ?? family
}

const PROVIDER_NAME_KEY = {
  qoder: 'providerQoder',
  'qoder-global': 'providerQoderGlobal',
  workbuddy: 'providerWorkbuddy',
  'workbuddy-ai': 'providerWorkbuddyAi',
  trae: 'providerTrae',
  'trae-global': 'providerTraeGlobal',
} as const satisfies Record<ProviderId, ConnectHubKey>

/** Localized official route name, e.g. "Qoder 国际版" / "WorkBuddy AI". */
export function providerDisplayName(t: ConnectHubTranslate, id: ProviderId): string {
  return t(PROVIDER_NAME_KEY[id])
}

/** Display name of the desktop app behind one route, for sign-in hints. */
export function providerAppName(t: ConnectHubTranslate, id: ProviderId): string {
  return id === 'workbuddy-ai' ? t('providerWorkbuddyAi') : familyLabelOf(familyOfProvider(id))
}

/** Find one provider status by id in a hub snapshot. */
export function findProvider(status: HubStatus | null, id: ProviderId): ProviderStatus | undefined {
  return status?.providers.find((provider) => provider.id === id)
}

/** Whether a record-shaped value carries the requested string field. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the provider of the session's selected model. `next` (a selection the
 * next request will use) outranks `lastUsed`; unknown shapes yield undefined.
 */
export function selectedProviderOf(projection: unknown): ProviderId | undefined {
  if (!isRecord(projection)) return undefined
  for (const key of ['next', 'lastUsed'] as const) {
    const selection = projection[key]
    if (isRecord(selection) && typeof selection.provider === 'string' && isProviderId(selection.provider)) {
      return selection.provider
    }
  }
  return undefined
}

/** Stable key used to mark one action as busy across sections. */
export function actionBusyKey(action: {
  type: string
  provider?: ProviderId | string
  modelId?: string
  accountId?: string
}): string {
  const base = `${action.type}:${action.provider ?? ''}:${action.modelId ?? ''}`
  return action.accountId === undefined ? base : `${base}:${action.accountId}`
}

/** The account the provider currently uses, for multi-account families. */
export function selectedAccountOf(provider: ProviderStatus): AccountView | undefined {
  if (provider.accounts === undefined) return undefined
  return provider.accounts.find((account) => account.selected) ?? provider.accounts[0]
}

/** Region-level credits, falling back to the selected account's credits. */
export function effectiveCredits(provider: ProviderStatus): CreditsView | undefined {
  return provider.credits ?? selectedAccountOf(provider)?.credits
}

/** Region-level check-in, falling back to the selected account's check-in. */
export function effectiveCheckin(provider: ProviderStatus): CheckinView | undefined {
  return provider.checkin ?? selectedAccountOf(provider)?.checkin
}

/** Amount plus plan the composer readout can show, or undefined when unknown. */
export function creditSummary(provider: ProviderStatus): { amount?: number; plan?: string } | undefined {
  const credits = effectiveCredits(provider)
  if (credits === undefined) return undefined
  if (typeof credits.remaining === 'number') return { amount: credits.remaining }
  if (credits.plan !== undefined && credits.plan !== '') return { plan: credits.plan }
  return undefined
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US')
const CREDITS_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** Group digits so large balances stay readable ("12,340"). */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return NUMBER_FORMAT.format(Math.round(value))
}

/** Balances may be fractional ("898.87"); keep up to two decimals when they are. */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return formatNumber(value)
  return CREDITS_FORMAT.format(value)
}

/** Billing multiplier as shown next to a model ("×0.5", "×1", "×2.25"). */
export function formatMultiplier(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 100) / 100
  return `×${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`
}

/** Compact context-window size ("128K", "1M"); 0 reads as "0". */
export function formatTokenWindow(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) {
    const millions = Math.round((value / 1_000_000) * 10) / 10
    return `${Number.isInteger(millions) ? String(millions) : millions.toFixed(1)}M`
  }
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(Math.round(value))
}

/** Filled share of a finite budget, clamped to 0–100; undefined without a total. */
export function progressPercent(remaining: number | undefined, total: number | undefined): number | undefined {
  if (remaining === undefined || total === undefined || total <= 0) return undefined
  const percent = (remaining / total) * 100
  return Math.max(0, Math.min(100, percent))
}

/** Two-digit clock text from a minute-of-day value. */
export function formatClockMinute(minute: number): string {
  const safe = ((Math.round(minute) % 1440) + 1440) % 1440
  const hours = Math.floor(safe / 60)
  return `${String(hours).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

/** Parse an "HH:mm" time input back into a minute of day; undefined when invalid. */
export function parseClockMinute(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const UTC8_OFFSET_MS = 8 * HOUR_MS

/** Next occurrence of a UTC+8 minute-of-day, strictly after `now`. */
export function nextCheckinAt(minute: number, now: number): number {
  const shifted = new Date(now + UTC8_OFFSET_MS)
  const utc8Midnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - UTC8_OFFSET_MS
  const candidate = utc8Midnight + Math.max(0, Math.min(1439, Math.round(minute))) * 60_000
  return candidate > now ? candidate : candidate + DAY_MS
}

/** Local date-time text ("2026-10-18 09:30"). */
export function formatDateTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Relative-time bucket of a timestamp, for localized "3m ago" copy. */
export function relativeBucket(at: number, now: number): { unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'; n: number } {
  const delta = Math.max(0, now - at)
  if (delta < 60_000) return { unit: 'now', n: 0 }
  if (delta < HOUR_MS) return { unit: 'minutes', n: Math.floor(delta / 60_000) }
  if (delta < DAY_MS) return { unit: 'hours', n: Math.floor(delta / HOUR_MS) }
  if (delta < 30 * DAY_MS) return { unit: 'days', n: Math.floor(delta / DAY_MS) }
  if (delta < 365 * DAY_MS) return { unit: 'months', n: Math.floor(delta / (30 * DAY_MS)) }
  return { unit: 'years', n: Math.floor(delta / (365 * DAY_MS)) }
}

/** Localized relative-time text ("3 分钟前" / "3m ago"). */
export function relativeText(t: ConnectHubTranslate, at: number, now: number): string {
  const { unit, n } = relativeBucket(at, now)
  switch (unit) {
    case 'now': return t('relativeNow')
    case 'minutes': return t('relativeMinutes', { n })
    case 'hours': return t('relativeHours', { n })
    case 'days': return t('relativeDays', { n })
    case 'months': return t('relativeMonths', { n })
    case 'years': return t('relativeYears', { n })
  }
}

/** How close an expiry is: past, inside the warning window, or comfortable. */
export type ExpiryLevel = 'expired' | 'soon' | 'ok'

const EXPIRY_SOON_MS = 2 * DAY_MS

export function expiryLevel(at: number | undefined, now: number): ExpiryLevel | undefined {
  if (at === undefined || !Number.isFinite(at)) return undefined
  if (at <= now) return 'expired'
  return at - now <= EXPIRY_SOON_MS ? 'soon' : 'ok'
}

/** Tone family of a provider state, for tags and dots. */
export type ProviderState = ProviderStatus['state']

/** Map a provider or family state to the dot mark used by the page and readout. */
export function stateDot(state: ProviderState | 'unknown'): 'done' | 'warning' | 'error' | 'idle' {
  switch (state) {
    case 'ready': return 'done'
    case 'error': return 'error'
    case 'needs-credential':
    case 'signed-out': return 'warning'
    default: return 'idle'
  }
}

/** Aggregate health of one family across its reported providers. */
export interface FamilyHealth {
  family: ProviderFamily
  label: string
  state: ProviderState | 'unknown'
  ready: number
  total: number
  warnings: number
  /** True when at least one region works but another one does not. */
  partial: boolean
}

/**
 * Health chips summarize a family, not each region: a family is READY as soon
 * as one of its regions is usable (the panel below shows the region detail),
 * and `partial` marks the mixed case so the chip can add "1/2". Only when no
 * region works does the chip take a warning/error tone.
 */
export function familyHealth(status: HubStatus | null): FamilyHealth[] {
  return FAMILIES.map((family) => {
    const providers = status?.providers.filter((provider) => provider.family === family.id) ?? []
    let ready = 0
    let warnings = 0
    for (const provider of providers) {
      if (provider.state === 'ready') ready += 1
      warnings += provider.warnings.length
    }
    let state: ProviderState | 'unknown'
    if (providers.length === 0) state = 'unknown'
    else if (ready > 0) state = 'ready'
    else if (providers.some((provider) => provider.state === 'error')) state = 'error'
    else if (providers.some((provider) => provider.state === 'signed-out')) state = 'signed-out'
    else state = 'needs-credential'
    return {
      family: family.id,
      label: family.label.zh,
      state,
      ready,
      total: providers.length,
      warnings,
      partial: ready > 0 && ready < providers.length,
    }
  })
}

/** Enabled/total model counts for the toolbar summary. */
export function modelCounts(models: readonly HubModel[]): { enabled: number; total: number } {
  let enabled = 0
  for (const model of models) if (model.enabled) enabled += 1
  return { enabled, total: models.length }
}

/** Case-insensitive search over model name, id and badge labels. */
export function filterModels(models: readonly HubModel[], query: string): HubModel[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...models]
  return models.filter((model) =>
    model.name.toLowerCase().includes(needle)
    || model.id.toLowerCase().includes(needle)
    || model.badges.some((badge) => badge.toLowerCase().includes(needle)),
  )
}

/** Ids of every model, for bulk enable/disable and bulk probe actions. */
export function allModelIds(models: readonly HubModel[]): string[] {
  return models.map((model) => model.id)
}

/** Whether a credit package is worth flagging for expiry. */
export function packageExpiryLevel(item: CreditsPackage, now: number): ExpiryLevel | undefined {
  return expiryLevel(item.expiresAt, now)
}

/**
 * Stable host warning codes mapped onto this plugin's dictionary.
 *
 * Host warnings are data: the host writes one Chinese sentence for logs and
 * non-UI consumers, and the client owns the localized copy. Unknown codes fall
 * back to the host text so a future warning is never blank.
 */
const WARNING_KEY: Readonly<Record<string, ConnectHubKey>> = {
  'credential-missing': 'warningCredentialMissing',
  'credential-reading': 'warningCredentialReading',
  'credential-rejected': 'warningCredentialRejected',
  'provider-unavailable': 'warningProviderUnavailable',
  'catalog-unavailable': 'warningCatalogUnavailable',
  'usage-unavailable': 'warningUsageUnavailable',
  'credential-unusable': 'warningCredentialUnusable',
  'no-credential': 'warningNoCredential',
  'token-expired': 'warningTokenExpired',
  'refresh-expired': 'warningRefreshExpired',
  'refresh-expiring': 'warningRefreshExpiring',
  'credential-error': 'warningCredentialError',
  'transport-error': 'warningTransportError',
  'catalog-error': 'warningCatalogError',
  'credits-error': 'warningCreditsError',
  'credits-expiring-24h': 'warningCreditsExpiring24h',
  'credits-expiring-7d': 'warningCreditsExpiring7d',
  'rate-unknown': 'warningRateUnknown',
  'no_account': 'warningNoAccount',
  'account_missing': 'warningAccountMissing',
  'desktop-credential-rejected': 'warningDesktopCredentialRejected',
  'desktop-login-unsupported': 'warningDesktopLoginUnsupported',
  'desktop-login-unreadable': 'warningDesktopLoginUnreadable',
  'credential': 'warningCredential',
  'catalog': 'warningCatalog',
  'catalog_fallback': 'warningCatalogFallback',
  'usage': 'warningUsage',
  'checkin_device_used': 'warningCheckinDeviceUsed',
  'credential_refresh_expired': 'warningCredentialRefreshExpired',
  'pi-ai-legacy': 'warningPiAiLegacy',
  'status_failed': 'warningStatusFailed',
}

const COUNT_WARNING_CODES: ReadonlySet<string> = new Set([
  'credits-expiring-24h',
  'credits-expiring-7d',
  'rate-unknown',
])

/** Localized text for a host warning; unknown codes keep the host sentence. */
export function warningText(
  t: ConnectHubTranslate,
  warning: Pick<WarningView, 'code' | 'message' | 'params'>,
): string {
  const key = WARNING_KEY[warning.code]
  if (key === undefined) return warning.message
  const count = warning.params?.['count']
  if (COUNT_WARNING_CODES.has(warning.code) && count === undefined) return warning.message
  return count === undefined ? t(key) : t(key, { count })
}

/** Stable host success codes mapped onto the dictionary. */
const ACTION_SUCCESS_KEY: Readonly<Record<string, ConnectHubKey>> = {
  'catalog-refreshed': 'actionCatalogRefreshed',
  'usage-refreshed': 'actionUsageRefreshed',
  'login-imported': 'actionLoginImported',
  'login-latest': 'actionLoginLatest',
  'pat-saved': 'actionPatSaved',
  'credential-cleared': 'actionCredentialCleared',
  'models-enabled': 'actionModelsEnabled',
  'models-disabled': 'actionModelsDisabled',
  'max-context-on': 'actionMaxContextOn',
  'max-context-off': 'actionMaxContextOff',
  'checkin-schedule-on': 'actionScheduleOn',
  'checkin-schedule-off': 'actionScheduleOff',
  'checkin-time-set': 'actionScheduleTime',
  'checkin-log-cleared': 'actionCheckinLogCleared',
  'checkin-claimed': 'actionCheckinClaimed',
  'checkin-claimed-plain': 'actionCheckinClaimedPlain',
  'checkin-already': 'actionCheckinAlready',
  'checkin-window-closed': 'actionCheckinWindowClosed',
  'checkin-no-campaign': 'actionCheckinNoCampaign',
  'checkin-device-used': 'actionCheckinDeviceUsed',
  'checkin-disabled': 'actionCheckinDisabled',
  'checkin-failed': 'actionCheckinFailed',
  'probe-consent-on': 'actionProbeConsentOn',
  'probe-consent-off': 'actionProbeConsentOff',
  'probe-done': 'actionProbeDone',
  'probe-skipped': 'actionProbeSkipped',
  'probe-inconclusive': 'actionProbeInconclusive',
  'probe-levels': 'actionProbeLevels',
  'probe-no-levels': 'actionProbeNoLevels',
  'models-probed': 'actionModelsProbed',
  'models-probed-skipped': 'actionModelsProbedSkipped',
  'models-tested': 'actionModelsTested',
  'models-tested-auth': 'actionModelsTestedAuth',
  'accounts-read': 'actionAccountsRead',
  'account-switched': 'actionAccountSwitched',
  'accounts-imported': 'actionAccountsImported',
  'accounts-imported-skipped': 'actionAccountsImportedSkipped',
  'accounts-none-imported': 'actionAccountsNoneImported',
  'accounts-exported': 'actionAccountsExported',
}

/** Stable host error codes mapped onto the dictionary. */
const ACTION_ERROR_KEY: Readonly<Record<string, ConnectHubKey>> = {
  not_configured: 'actionNotConfigured',
  catalog_refresh_failed: 'actionCatalogFailed',
  usage_refresh_failed: 'actionUsageFailed',
  checkin_failed: 'actionCheckinFailed',
  checkin_no_campaign: 'actionCheckinNoCampaign',
  credential_unusable: 'actionCredentialUnusable',
  desktop_login_rejected: 'actionCredentialUnusable',
  desktop_login_unreadable: 'actionCredentialUnusable',
  desktop_login_not_found: 'actionLoginNotFound',
  desktop_login_unsupported: 'actionLoginUnsupported',
  invalid_secret: 'actionSecretEmpty',
  secret_rejected: 'actionSecretRejected',
  probe_forbidden: 'actionProbeForbidden',
  probe_failed: 'actionProbeFailed',
  unknown_model: 'actionUnknownTarget',
  unknown_account: 'actionUnknownTarget',
  invalid_request: 'actionInvalidRequest',
  unsupported: 'actionUnsupported',
  preference_write_failed: 'actionPreferenceFailed',
  identity_unavailable: 'actionIdentityUnavailable',
  provider_unknown: 'actionProviderUnavailable',
}

/** Stable host check-in log codes mapped onto the dictionary. */
const CHECKIN_LOG_KEY: Readonly<Record<string, ConnectHubKey>> = {
  'checkin-claimed': 'checkinLogClaimed',
  'checkin-claimed-plain': 'checkinLogClaimedPlain',
  'checkin-already': 'checkinLogAlready',
  'checkin-device-used': 'checkinLogDeviceUsed',
  'checkin-disabled': 'checkinLogDisabled',
  'checkin-window-closed': 'checkinLogWindowClosed',
  'checkin-no-campaign': 'checkinLogNoCampaign',
  'checkin-failed': 'checkinLogFailed',
  'checkin-failed-reason': 'checkinLogFailedReason',
}

/** Localized success text: a known code wins, the host sentence is the fallback. */
export function actionSuccessText(
  t: ConnectHubTranslate,
  result: { code?: string | undefined; params?: HostMessageParams | undefined; message?: string | undefined },
): string | undefined {
  const key = result.code === undefined ? undefined : ACTION_SUCCESS_KEY[result.code]
  if (key !== undefined) return t(key, result.params)
  return result.message
}

/** Localized failure text: a known code wins, the host detail is the fallback. */
export function actionErrorText(
  t: ConnectHubTranslate,
  result: { error?: string | undefined; detail?: string | undefined },
): string {
  const key = result.error === undefined ? undefined : ACTION_ERROR_KEY[result.error]
  if (key !== undefined) return t(key)
  return result.detail ?? t('actionRejected')
}

/** Localize one check-in log row, falling back to the stored sentence. */
export function checkinLogText(t: ConnectHubTranslate, row: Pick<CheckinLogRow, 'code' | 'params' | 'message'>): string {
  const key = row.code === undefined ? undefined : CHECKIN_LOG_KEY[row.code]
  return key === undefined ? row.message : t(key, row.params)
}

/**
 * Known single-language labels from the host (credit plan and package names,
 * Trae edition labels). The value acts as a stable key, so the same string is
 * localized in either language; anything upstream-specific stays verbatim.
 */
const KNOWN_LABEL_KEY: Readonly<Record<string, ConnectHubKey>> = {
  '不限额度': 'planUnlimited',
  '个人额度': 'planPersonal',
  '组织资源包': 'planOrganization',
  '赠送额度': 'planGift',
  '专属资源包': 'planExclusive',
  'enterprise': 'accountEnterprise',
  '免费': 'badgeFree',
  '国内桌面版': 'traeEditionCnDesktop',
  '国际桌面版': 'traeEditionGlobalDesktop',
  'SOLO 国内版': 'traeEditionCnSolo',
  'SOLO 国际版': 'traeEditionGlobalSolo',
}

/** Localize a known host label; unknown values are returned unchanged. */
export function localizedServerLabel(t: ConnectHubTranslate, value: string): string {
  const key = KNOWN_LABEL_KEY[value]
  return key === undefined ? value : t(key)
}
