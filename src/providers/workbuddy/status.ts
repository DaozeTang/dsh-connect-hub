/**
 * Provider status document for one WorkBuddy route.
 *
 * Pure mapping from cached runtime state: no I/O, no secrets. The credential is
 * described by masked metadata only, and every warning is a user-facing,
 * already-redacted sentence in Chinese (warnings are data; the UI translates
 * its own labels).
 */

import type { CheckinView, CreditsView, HubModel, ProbeView, ProviderStatus, WarningView } from '../../shared/contracts.ts'
import type { ProviderDescriptor } from '../../core/types.ts'
import type { WorkBuddyAuthStatus } from './auth.ts'
import type { WorkBuddyCredits } from './upstream.ts'

/** Where the served catalog came from, in degradation order. */
export type WorkBuddyCatalogSource = 'live' | 'saved' | 'builtin'

/** Credential metadata the status document may expose (never the token). */
export interface WorkBuddyCredentialView {
  source: 'plugin' | 'app'
  /** The hub never edits the desktop app's own sign-in; refreshes go to the vault. */
  writable: boolean
  savedAt?: number
  masked?: string
  expiresAt?: number
  refreshExpiresAt?: number
}

/** Everything {@link buildProviderStatus} needs, all already cached. */
export interface WorkBuddyStatusInput {
  descriptor: ProviderDescriptor
  auth: WorkBuddyAuthStatus
  credential: WorkBuddyCredentialView | undefined
  account: { label?: string; detail?: string; enterprise?: boolean }
  /** Present when a credential exists but a hard failure prevents use. */
  credentialError: string | undefined
  /** Present when the loopback transport or adapter registration failed. */
  transportError: string | undefined
  catalog: {
    source: WorkBuddyCatalogSource
    updatedAt?: number
    error?: string
    models: HubModel[]
  }
  credits: CreditsView | undefined
  /** Present for the CN route when check-in state is known. */
  checkin?: CheckinView | undefined
  probeConsent: boolean
  probeRows: ProbeView[]
  warnings: WarningView[]
}

/** How soon before refresh expiry to warn. */
const REFRESH_EXPIRY_NOTICE_MS = 10 * 60 * 1000

/** Derive the coarse route state the UI renders. */
function routeState(input: WorkBuddyStatusInput): ProviderStatus['state'] {
  if (input.auth.state !== 'signed-in') return input.auth.reason === undefined ? 'needs-credential' : 'error'
  const healthy = input.credentialError === undefined && input.transportError === undefined
  return healthy ? 'ready' : 'error'
}

/** The optional account block; omitted entirely when there is no label. */
function accountBlock(account: WorkBuddyStatusInput['account']): ProviderStatus['account'] | undefined {
  if (account.label === undefined) return undefined
  return {
    label: account.label,
    ...(account.detail === undefined ? {} : { detail: account.detail }),
    ...(account.enterprise === true ? { enterprise: true } : {}),
  }
}

/** The catalog block with optional provenance fields. */
function catalogBlock(catalog: WorkBuddyStatusInput['catalog']): ProviderStatus['catalog'] {
  return {
    source: catalog.source,
    ...(catalog.updatedAt === undefined ? {} : { updatedAt: catalog.updatedAt }),
    ...(catalog.error === undefined ? {} : { error: catalog.error }),
    models: catalog.models,
  }
}

/** Build the provider status document. */
export function buildProviderStatus(input: WorkBuddyStatusInput): ProviderStatus {
  const account = accountBlock(input.account)
  return {
    id: input.descriptor.id,
    family: input.descriptor.family,
    region: input.descriptor.region,
    label: input.descriptor.label,
    state: routeState(input),
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    ...(account === undefined ? {} : { account }),
    ...(input.credits === undefined ? {} : { credits: input.credits }),
    ...(input.checkin === undefined ? {} : { checkin: input.checkin }),
    probes: { supported: true, consent: input.probeConsent, rows: input.probeRows },
    catalog: catalogBlock(input.catalog),
    warnings: input.warnings,
    capabilities: {
      usage: true,
      checkin: input.descriptor.region === 'cn',
      transfer: false,
      probes: true,
      multiAccount: false,
    },
  }
}

/** Inputs the warning list is derived from. */
export interface WarningInput {
  appName: string
  auth: WorkBuddyAuthStatus
  credentialError: string | undefined
  transportError: string | undefined
  catalogSource: WorkBuddyCatalogSource
  catalogError: string | undefined
  creditsError: string | undefined
  credits: WorkBuddyCredits | undefined
  rateUnknownCount: number
  now: number
}

/** Warnings about the sign-in itself. */
function signInWarnings(input: WarningInput, app: string): WarningView[] {
  if (input.auth.state !== 'signed-in') {
    if (input.auth.reason !== undefined) {
      return [{ code: 'credential-unusable', level: 'error', message: `无法读取 ${app} 登录状态：${input.auth.reason}` }]
    }
    // A missing sign-in is a state to fix, not a failure, and Qoder and Trae
    // report it at the same level; the connection card already calls it out.
    return [{
      code: 'no-credential',
      level: 'info',
      message: `未找到 ${app} 桌面端登录，请先在 ${app} 桌面端登录一次`,
    }]
  }
  const warnings: WarningView[] = []
  const expiresAt = input.auth.expiresAtMs
  if (expiresAt !== undefined && expiresAt > 0 && expiresAt <= input.now) {
    warnings.push({
      code: 'token-expired',
      level: 'warn',
      message: `${app} 登录令牌已过期，插件会自动尝试刷新；若失败请在 ${app} 桌面端重新登录`,
    })
  }
  const refreshExpiresAt = input.auth.refreshExpiresAtMs
  if (refreshExpiresAt !== undefined && refreshExpiresAt > 0 && refreshExpiresAt <= input.now) {
    warnings.push({
      code: 'refresh-expired',
      level: 'warn',
      message: `${app} 登录状态已过期，请在 ${app} 桌面端重新登录`,
    })
  } else if (
    refreshExpiresAt !== undefined
    && refreshExpiresAt > 0
    && refreshExpiresAt - input.now <= REFRESH_EXPIRY_NOTICE_MS
  ) {
    warnings.push({ code: 'refresh-expiring', level: 'info', message: `${app} 登录状态即将过期，请留意刷新结果` })
  }
  return warnings
}

/** Warnings about a failed credential use or transport. */
function runtimeWarnings(input: WarningInput): WarningView[] {
  const warnings: WarningView[] = []
  if (input.credentialError !== undefined) {
    warnings.push({ code: 'credential-error', level: 'error', message: `登录状态异常：${input.credentialError}` })
  }
  if (input.transportError !== undefined) {
    warnings.push({ code: 'transport-error', level: 'error', message: input.transportError })
  }
  return warnings
}

/** Warnings about the served catalog. */
function catalogWarnings(input: WarningInput): WarningView[] {
  if (input.catalogError === undefined) return []
  const shownList = input.catalogSource === 'builtin' ? '内置模型列表' : '上次保存的模型列表'
  return [{
    code: 'catalog-error',
    level: 'warn',
    message: `模型目录刷新失败，当前显示的是${shownList}：${input.catalogError}`,
  }]
}

/** Warnings about credits: a failed read, or credit expiring soon. */
function creditsWarnings(input: WarningInput): WarningView[] {
  const warnings: WarningView[] = []
  if (input.creditsError !== undefined) {
    warnings.push({ code: 'credits-error', level: 'warn', message: `额度刷新失败：${input.creditsError}` })
  }
  const credits = input.credits
  if (credits === undefined || credits.unlimited === true) return warnings
  const within24h = credits.expiry?.within24h.total ?? 0
  const within7d = credits.expiry?.within7d.total ?? 0
  if (within24h > 0) {
    warnings.push({
      code: 'credits-expiring-24h',
      level: 'warn',
      message: `有 ${within24h} 积分将在 24 小时内过期，请尽快使用`,
      params: { count: within24h },
    })
  } else if (within7d > 0) {
    warnings.push({
      code: 'credits-expiring-7d',
      level: 'info',
      message: `有 ${within7d} 积分将在 7 天内过期`,
      params: { count: within7d },
    })
  }
  return warnings
}

/** Warnings about pricing that needs a refresh. */
function pricingWarnings(input: WarningInput): WarningView[] {
  if (input.rateUnknownCount <= 0) return []
  return [{
    code: 'rate-unknown',
    level: 'info',
    message: `${input.rateUnknownCount} 个模型的价格需要刷新模型目录后才能确认`,
    params: { count: input.rateUnknownCount },
  }]
}

/**
 * User-facing warnings, in a stable order: sign-in, runtime failures, catalog,
 * credits, pricing. Every entry names an action the user can take.
 */
export function buildWarnings(input: WarningInput): WarningView[] {
  const app = input.appName
  return [
    ...signInWarnings(input, app),
    ...runtimeWarnings(input),
    ...catalogWarnings(input),
    ...creditsWarnings(input),
    ...pricingWarnings(input),
  ]
}

/** Hub probe-row states, keyed by stored validation result. */
const PROBE_ROW_STATE: Readonly<Record<'validating' | 'non-validating' | 'unknown', ProbeView['state']>> = {
  validating: 'ok',
  'non-validating': 'inconclusive',
  unknown: 'unknown',
}

/** Convert a stored probe validation into the hub probe-row state. */
export function probeStateOf(validation: 'validating' | 'non-validating' | 'unknown'): ProbeView['state'] {
  return PROBE_ROW_STATE[validation]
}
