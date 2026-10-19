import type {
  CreditsPackage,
  CreditsView,
  HubModel,
  ModelReasoning,
  ProviderStatus,
} from '../../shared/contracts.ts'
import { maskAccountLabel } from '../../core/redact.ts'
import type { QoderCatalog, QoderModelInfo } from './catalog.ts'
import type { QoderDeviceCredential } from './credentials.ts'
import type { QoderCredits } from './upstream.ts'

/** The decimal form a rate label's multiplier may take after the leading `x`. */
const RATE_VALUE = /^\d+(?:\.\d+)?$/u

/** The UI multiplier derived from a catalog row's `x<n>` rate label. */
function multiplierFrom(info: QoderModelInfo): number | undefined {
  if (info.billing.free === true) return 0
  const label = info.billing.credits?.trim()
  if (label === undefined || label.length < 2 || !label.startsWith('x')) return undefined
  const digits = label.slice(1)
  if (!RATE_VALUE.test(digits)) return undefined
  const factor = Number(digits)
  return Number.isFinite(factor) ? factor : undefined
}

/** The declared reasoning capability as the model-picker contract wants it. */
function reasoningFrom(info: QoderModelInfo): ModelReasoning | null {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) return null
  return {
    supported: reasoning.supportedEfforts === undefined ? [] : [...reasoning.supportedEfforts],
    ...reasoning.defaultEffort === undefined ? {} : { default: reasoning.defaultEffort },
    canDisable: reasoning.canDisableThinking === true,
  }
}

/** The largest context window the service declared for one row. */
function largestDeclaredWindow(info: QoderModelInfo): number {
  const declared: number[] = info.supportedContextWindows === undefined ? [] : [...info.supportedContextWindows]
  if (info.defaultContextWindow !== undefined) declared.push(info.defaultContextWindow)
  declared.push(info.contextWindow)
  return declared.reduce((largest, window) => Math.max(largest, window), Number.NEGATIVE_INFINITY)
}

/**
 * Project one catalog row onto the hub's model view.
 *
 * `contextWindow` is the window currently served (the max-context preference is
 * already folded in by {@link QoderCatalog}), while `maxContextWindow` reports
 * the largest window the service ever advertised so the UI can explain the
 * preference.
 */
export function hubModelOf(info: QoderModelInfo, enabled: boolean, useMaxContext: boolean): HubModel {
  const multiplier = multiplierFrom(info)
  return {
    id: info.id,
    name: info.name,
    enabled,
    ...multiplier === undefined ? {} : { multiplier },
    badges: [],
    contextWindow: info.contextWindow,
    maxContextWindow: largestDeclaredWindow(info),
    useMaxContext,
    inputs: info.supportsImages ? ['text', 'image'] : ['text'],
    reasoning: reasoningFrom(info),
  }
}

/** Every catalog row, disabled ones included, each with its visibility flag. */
export function hubModelsOf(catalog: QoderCatalog, useMaxContext: boolean): HubModel[] {
  const disabled = new Set(catalog.getDisabledModels())
  return catalog.all().map(info => hubModelOf(info, !disabled.has(info.id), useMaxContext))
}

/** Parse an optional service timestamp into epoch milliseconds. */
function timestampOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Project one credit package onto the hub's package view. */
function creditPackageOf(
  account: QoderCredits['accounts'][number],
  index: number,
): CreditsPackage {
  const expiresAt = timestampOf(account.packageEndTime)
  return {
    id: account.packageCode === undefined ? `${index}:${account.packageName}` : account.packageCode,
    name: account.packageName,
    remaining: account.remain,
    ...account.size > 0 ? { total: account.size } : {},
    ...expiresAt === undefined ? {} : { expiresAt },
  }
}

/** Map the service's quota answer onto the hub's credits view. */
export function creditsViewOf(credits: QoderCredits, updatedAt = Date.now()): CreditsView {
  const packages = credits.accounts.map(creditPackageOf)
  const resetAt = timestampOf(credits.cycleResetTime)
  const reset = resetAt === undefined ? {} : { resetAt }
  if (credits.unlimited === true) {
    return { kind: 'credits', ...reset, updatedAt, packages }
  }
  const remaining = credits.accounts.reduce((sum, account) => sum + account.remain, 0)
  return {
    kind: 'credits',
    remaining,
    ...credits.totalSize === undefined ? {} : { total: credits.totalSize },
    ...reset,
    updatedAt,
    packages,
  }
}

/**
 * Project a desktop-imported sign-in onto the hub's account view. The nickname
 * is shown as-is unless it looks like an email or phone number; the detail line
 * keeps the account identifiable without echoing the raw address.
 */
export function deviceAccountView(credential: QoderDeviceCredential): NonNullable<ProviderStatus['account']> {
  // Language-neutral on purpose: the client localizes its own labels, while
  // this value can only be returned as-is in both locales.
  const label = maskAccountLabel(credential.user.name)
    ?? (credential.user.id === '' ? 'Qoder' : `Qoder · ${credential.user.id.slice(-4)}`)
  const email = maskAccountLabel(credential.user.email)
  return {
    label,
    ...email === undefined ? {} : { detail: email },
  }
}
