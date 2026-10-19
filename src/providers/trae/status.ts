import type {
  AccountView,
  BilingualText,
  ProviderCredentialView,
  ProviderId,
  ProviderStatus,
  ProbeView,
  WarningView,
} from '../../shared/contracts.ts'
import { maskTail } from '../../core/redact.ts'
import { maskAccountName } from './errors.ts'
import { traeAccountId, type TraeAccountChoice, type TraeCredential } from './auth.ts'
import type { TraeRuntimeSnapshot } from './state.ts'
import { TRAE_EDITION_LABELS } from './constants.ts'
import { hubModelOf } from './model-selection.ts'
import type { TraePrefs } from './prefs.ts'
import type { TraeRegion } from './region.ts'
import { checkinStateOf, checkinViewOf } from './usage-view.ts'

export interface TraeStatusInput {
  providerId: ProviderId
  region: TraeRegion
  label: BilingualText
  snapshot: TraeRuntimeSnapshot
  prefs: TraePrefs
}

const NO_ACCOUNT_MESSAGE = '未找到 Trae 登录，请先在 Trae 桌面端登录'
const MISSING_ACCOUNT_MESSAGE = '之前选择的账号已不在本机登录中，请重新选择账号'
const CATALOG_FALLBACK_MESSAGE = '尚未读取到实时模型目录，当前展示内置模型列表'
const DEVICE_USED_MESSAGE = '本机今日的签到名额可能已被其他账号使用，当前账号今日无法再签到'
const REFRESH_EXPIRED_MESSAGE = '所选账号的登录已过期，请在 Trae 桌面端重新登录'

/** Access-token expiry alone is fine while the refresh horizon is alive. */
function refreshHorizonDead(credential: TraeCredential | undefined): boolean {
  if (credential === undefined) return false
  const now = Date.now()
  if (!(credential.expiresAtMs > 0 && credential.expiresAtMs <= now)) return false
  return credential.refreshExpiresAtMs === undefined || credential.refreshExpiresAtMs <= now
}

/**
 * Whether one account row is usable. An expired access token is not a failure —
 * the provider rotates it on use — so only a lapse with no usable refresh
 * token makes an account read as expired.
 */
function accountRowState(
  account: TraeAccountChoice,
  selected: boolean,
  hardError: string | undefined,
): AccountView['state'] {
  if (hardError !== undefined && selected) return 'error'
  const now = Date.now()
  const accessExpired = account.tokenExpiresAtMs > 0 && account.tokenExpiresAtMs <= now
  const refreshUsable = account.refreshExpiresAtMs !== undefined && account.refreshExpiresAtMs > now
  return accessExpired && !refreshUsable ? 'expired' : 'ok'
}

function accountRowOf(
  account: TraeAccountChoice,
  snapshot: TraeRuntimeSnapshot,
  prefs: TraePrefs,
): AccountView {
  const isCurrent = snapshot.current !== undefined && traeAccountId(snapshot.current) === account.id
  const checkin = snapshot.checkinByAccount[account.id]
  return {
    id: account.id,
    label: maskAccountName(account.accountName),
    detail: TRAE_EDITION_LABELS[account.edition],
    selected: account.selected,
    state: accountRowState(account, account.selected, snapshot.hardError),
    ...account.tokenExpiresAtMs > 0 ? { expiresAt: account.tokenExpiresAtMs } : {},
    ...account.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: account.refreshExpiresAtMs },
    ...isCurrent && snapshot.credits !== undefined ? { credits: snapshot.credits } : {},
    ...checkin === undefined ? {} : { checkin: checkinViewOf(checkin, prefs.checkin) },
  }
}

function credentialOf(current: TraeCredential | undefined): ProviderCredentialView | undefined {
  if (current === undefined) return undefined
  const masked = maskTail(current.accessToken)
  return {
    source: current.source === 'dsh' ? 'plugin' : 'app',
    ...masked === undefined ? {} : { masked },
    ...current.expiresAtMs > 0 ? { expiresAt: current.expiresAtMs } : {},
    ...current.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: current.refreshExpiresAtMs },
    writable: false,
    ...(current.imported === true ? { imported: true } : {}),
  }
}

function warningsOf(input: TraeStatusInput): WarningView[] {
  const { snapshot, region } = input
  const warnings: WarningView[] = []
  if (snapshot.accounts.length === 0) {
    warnings.push({ code: 'no_account', level: 'info', message: NO_ACCOUNT_MESSAGE })
  } else if (snapshot.current === undefined) {
    warnings.push({ code: 'account_missing', level: 'warn', message: MISSING_ACCOUNT_MESSAGE })
  }
  if (snapshot.hardError !== undefined) {
    warnings.push({ code: 'credential', level: 'error', message: snapshot.hardError })
  }
  if (snapshot.catalogError !== undefined) {
    warnings.push({ code: 'catalog', level: 'warn', message: snapshot.catalogError })
  }
  if (snapshot.catalogSource === 'builtin' && snapshot.current !== undefined) {
    warnings.push({ code: 'catalog_fallback', level: 'info', message: CATALOG_FALLBACK_MESSAGE })
  }
  if (snapshot.creditsError !== undefined) {
    warnings.push({ code: 'usage', level: 'warn', message: snapshot.creditsError })
  }
  if (region === 'cn') {
    const selected = snapshot.accounts.find(account => account.selected)
    const checkin = selected === undefined ? undefined : snapshot.checkinByAccount[selected.id]
    if (checkin !== undefined && checkinStateOf(checkin) === 'device-used') {
      warnings.push({ code: 'checkin_device_used', level: 'info', message: DEVICE_USED_MESSAGE })
    }
  }
  if (snapshot.current !== undefined && refreshHorizonDead(snapshot.current)) {
    warnings.push({ code: 'credential_refresh_expired', level: 'error', message: REFRESH_EXPIRED_MESSAGE })
  }
  return warnings
}

function probeRowsOf(input: TraeStatusInput): ProbeView[] {
  const names = new Map(input.snapshot.catalog.map(model => [model.id, model.name]))
  return Object.values(input.prefs.probes).map(probe => ({
    ...probe,
    modelName: names.get(probe.modelId) ?? probe.modelId,
    efforts: [...probe.efforts],
  }))
}

function providerStateOf(snapshot: TraeRuntimeSnapshot): ProviderStatus['state'] {
  if (snapshot.accounts.length === 0) return 'needs-credential'
  if (snapshot.current === undefined || snapshot.hardError !== undefined) return 'error'
  if (refreshHorizonDead(snapshot.current)) return 'error'
  return 'ready'
}

/** Build the hub status document from cached runtime state only. */
export function buildTraeStatus(input: TraeStatusInput): ProviderStatus {
  const { snapshot, prefs, region, providerId, label } = input
  const selected = snapshot.accounts.find(account => account.selected)
  const checkin = selected === undefined ? undefined : snapshot.checkinByAccount[selected.id]
  const credential = snapshot.current === undefined ? undefined : credentialOf(snapshot.current)
  return {
    id: providerId,
    family: 'trae',
    region: region === 'ai' ? 'global' : 'cn',
    label,
    state: providerStateOf(snapshot),
    ...credential === undefined ? {} : { credential },
    ...selected === undefined ? {} : {
      account: {
        label: maskAccountName(selected.accountName),
        detail: TRAE_EDITION_LABELS[selected.edition],
      },
    },
    accounts: snapshot.accounts.map(account => accountRowOf(account, snapshot, prefs)),
    ...snapshot.credits === undefined ? {} : { credits: snapshot.credits },
    ...region === 'ai' ? {} : { checkin: checkinViewOf(checkin, prefs.checkin) },
    probes: { supported: true, consent: prefs.probeConsent, rows: probeRowsOf(input) },
    transfer: { supported: true },
    catalog: {
      source: snapshot.catalogSource,
      ...snapshot.catalogUpdatedAt === undefined ? {} : { updatedAt: snapshot.catalogUpdatedAt },
      ...snapshot.catalogError === undefined ? {} : { error: snapshot.catalogError },
      // No signed-in account serves no models at all, matching the sibling
      // providers and the README's empty-region contract.
      models: snapshot.current === undefined ? [] : snapshot.catalog.map(model => hubModelOf(model, prefs)),
    },
    warnings: warningsOf(input),
    capabilities: {
      usage: true,
      checkin: region === 'cn',
      transfer: true,
      probes: true,
      multiAccount: true,
    },
  }
}
