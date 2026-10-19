import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { BilingualText, CheckinState, CheckinLogRow, HubAction, ProviderId, ProviderStatus, ProbeView } from '../../shared/contracts.ts'
import type { ProviderActionResult, ProviderDeps, ProviderDescriptor, ProviderRuntime } from '../../core/types.ts'
import { ProviderActionError } from '../../core/types.ts'
import { SingleFlight } from '../../core/scheduler.ts'
import { IdentityGuard } from '../../core/identity.ts'
import { createTraeAdapter, type TraeAdapter } from './adapter.ts'
import {
  traeAccountId,
  TraeCredentialStore,
  VaultTraeCredentialPersistence,
  type TraeCredential,
} from './auth.ts'
import { loadTraeCatalogCache, saveTraeCatalogCache } from './catalog-cache.ts'
import { fallbackModelsFor, mergeTraeModelSources, TraeCatalog, type TraeModelInfo } from './catalog.ts'
import {
  TRAE_ACCOUNT_READ_LIMIT,
  TRAE_CHECKIN_DEVICE_CLAIMED_CODE,
  TRAE_MODELS_TEST_LIMIT,
  TRAE_PROVIDER_DISPLAY_NAMES,
  TRAE_SETTINGS_NS,
  TRAE_USAGE_REFRESH_INTERVAL_MS,
  TRAE_VAULT_SLOTS,
} from './constants.ts'
import { maskAccountName, safeErrorText } from './errors.ts'
import { resolveTraeIdentity, type TraeIdentity } from './identity.ts'
import { servedModelsOf } from './model-selection.ts'
import { probeModelsSequentially, type TraeProbeResult } from './model-probe.ts'
import { traeStorageCandidates, type TraeEdition } from './paths.ts'
import { parseTraePrefs, withCheckinLog, type TraePrefs } from './prefs.ts'
import { refreshTraeCredential, type TraeRefreshDevice } from './refresh.ts'
import { regionOfEdition, type TraeRegion } from './region.ts'
import { createTraeShim, type ShimLogger, type TraeShim } from './shim.ts'
import { TraeSoloBridge, type TraeWireTarget } from './solo-bridge.ts'
import { TraeSoloUpstreamClient } from './solo.ts'
import { TraeSoloRemoteCatalogClient } from './solo-remote.ts'
import type { TraeRuntimeSnapshot } from './state.ts'
import { buildTraeStatus } from './status.ts'
import { parseTransferFile, mergeTransferRecords } from './transfer.ts'
import { previewTransferOf, transferExportOf, transferIndexesOf } from './transfer-hub.ts'
import {
  checkinClaimOutcome,
  checkinPreflight,
  checkinSnapshotOf,
  creditsViewOfPayStatus,
  creditsViewOfSnapshot,
  type TraeCheckinSnapshot,
} from './usage-view.ts'
import { TraeUsageClient, type TraeCheckinStatus } from './usage.ts'

export interface TraeRuntimeOptions {
  deps: ProviderDeps
  region: TraeRegion
  providerId: ProviderId
  label: BilingualText
}

const DIRECTORY_RETRY_DELAY_MS = 800

function describeLogArg(value: unknown): string {
  if (typeof value === 'string') return safeErrorText(value, 1_000)
  if (value instanceof Error) return safeErrorText(value.message, 1_000)
  try {
    return safeErrorText(JSON.stringify(value), 1_000)
  } catch {
    return safeErrorText(String(value), 1_000)
  }
}

function withDirectoryRetry<T>(read: () => Promise<T>): Promise<T> {
  return read().catch(async (first: unknown) => {
    // The directory gateways answer an intermittent 401 for a credential that
    // works moments later; one failed read must not collapse the catalog.
    await new Promise(resolve => setTimeout(resolve, DIRECTORY_RETRY_DELAY_MS))
    return read().catch(() => {
      throw first
    })
  })
}

function errorCheckinSnapshot(readAt: number, error: unknown): TraeCheckinSnapshot {
  return {
    checkedIn: false,
    didCheckedIn: false,
    credits: 0,
    enabled: true,
    readAt,
    error: safeErrorText(error),
  }
}

function probeViewOf(result: TraeProbeResult, model: TraeModelInfo | undefined): ProbeView {
  // A timeout or transport failure is "not determined", never "unusable".
  const state: ProbeView['state'] = result.verdict === 'available'
    ? 'ok'
    : result.verdict === 'unknown'
      ? 'unknown'
      : 'error'
  return {
    modelId: result.id,
    modelName: model?.name ?? result.id,
    state,
    efforts: model?.reasoning === undefined ? [] : [...model.reasoning.supported],
    ...result.detail === '' ? {} : { message: result.detail },
    at: Date.now(),
  }
}

export class TraeProviderRuntime implements ProviderRuntime {
  readonly descriptor: ProviderDescriptor
  private readonly deps: ProviderDeps
  private readonly region: TraeRegion
  private readonly prefsKey: string
  private prefs: TraePrefs
  private snapshot: TraeRuntimeSnapshot
  private readonly catalog: TraeCatalog
  private store: TraeCredentialStore | undefined
  private shim: TraeShim | undefined
  private soloClient: TraeSoloUpstreamClient | undefined
  private remoteCatalog: TraeSoloRemoteCatalogClient | undefined
  private usageClient: TraeUsageClient | undefined
  private bridge: TraeSoloBridge | undefined
  private adapter: TraeAdapter | undefined
  private registration: AdapterRegistrationHandle | undefined
  private directoryRegistration: DirectoryRegistrationHandle | undefined
  private readonly wireById = new Map<string, TraeWireTarget>()
  private readonly wireByName = new Map<string, TraeWireTarget>()
  private usageFlight = new SingleFlight<void>()
  private readonly catalogFlight = new SingleFlight<{ models: number; updatedAt: number }>()
  /** Account identity of every async read, stamped before it starts. */
  private readonly identity = new IdentityGuard()
  private initialized = false
  private disposed = false
  /** Whether the first local-account scan has completed. */
  private syncedAccounts = false

  constructor(options: TraeRuntimeOptions) {
    this.deps = options.deps
    this.region = options.region
    this.prefsKey = `provider:${options.providerId}`
    this.prefs = parseTraePrefs(undefined)
    this.catalog = new TraeCatalog(options.region)
    this.snapshot = {
      accounts: [],
      catalog: fallbackModelsFor(options.region),
      catalogSource: 'builtin',
      checkinByAccount: {},
    }
    this.descriptor = {
      id: options.providerId,
      family: 'trae',
      region: options.region === 'ai' ? 'global' : 'cn',
      label: options.label,
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      this.prefs = await this.loadPreferences()
      const cached = await loadTraeCatalogCache(this.deps.paths.stateDir, this.region)
      if (cached !== undefined) {
        this.snapshot.catalog = cached.models
        this.snapshot.catalogSource = 'saved'
        this.snapshot.catalogUpdatedAt = cached.updatedAt
      }
      this.store = this.createStore()
      this.store.selectAccount(this.prefs.selectedAccountId)
      this.soloClient = new TraeSoloUpstreamClient({
        credential: () => this.requireStore().resolve(),
        identity: () => this.resolveIdentity(),
        log: (message, detail) => this.deps.log.warn(`${message} ${detail === undefined ? '' : describeLogArg(detail)}`.trim()),
      })
      this.remoteCatalog = new TraeSoloRemoteCatalogClient({ credential: () => this.requireStore().resolve() })
      this.usageClient = new TraeUsageClient({
        credential: () => this.requireStore().resolve(),
        deviceId: () => this.deviceIdSafe(),
      })
      this.bridge = new TraeSoloBridge(this.requireSoloClient(), this.catalog, displayId => this.wireTargetOf(displayId))
      await this.syncAccounts()
      this.applyCatalog(false)

      const shim = createTraeShim({
        catalog: this.catalog,
        client: this.bridge,
        logger: this.shimLogger(),
      })
      this.shim = shim
      await shim.ready
      if (this.disposed) {
        await shim.close()
        return
      }
      this.adapter = createTraeAdapter({
        shim,
        catalog: this.catalog,
        provider: this.descriptor.id,
        displayName: TRAE_PROVIDER_DISPLAY_NAMES[this.region],
        resolveAttachments: () => this.deps.ctx.get('attachments') as AttachmentStore | undefined,
      })
      this.registration = this.deps.ctx.llm.registerAdapter([this.descriptor.id], this.adapter.adapter)
      this.directoryRegistration = this.deps.ctx.llm.registerConfigurableProviders([{
        provider: this.descriptor.id,
        displayName: TRAE_PROVIDER_DISPLAY_NAMES[this.region],
        settingsNs: TRAE_SETTINGS_NS,
        settingsPath: [],
        declared: false,
      }])
      this.applyCatalog(true)

      this.scheduleUsageRefresh()
      this.scheduleCheckin()
      if (this.snapshot.accounts.length > 0) {
        void this.refreshCatalogWithState().catch(error => {
          this.deps.log.warn(`${this.descriptor.id}: startup model directory unavailable (${safeErrorText(error)})`)
        })
        void this.refreshUsage().catch(error => {
          this.deps.log.warn(`${this.descriptor.id}: startup usage unavailable (${safeErrorText(error)})`)
        })
      }
      this.notify()
    } catch (error: unknown) {
      this.deps.log.error(`${this.descriptor.id}: init failed: ${safeErrorText(error)}`)
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.deps.scheduler.clear(`${this.descriptor.id}:usage`)
    this.deps.scheduler.clear(`${this.descriptor.id}:checkin`)
    try { this.registration?.() } catch { /* already released */ }
    try { this.directoryRegistration?.() } catch { /* already released */ }
    const shim = this.shim
    this.shim = undefined
    if (shim !== undefined) await shim.close().catch(error => {
      this.deps.log.warn(`${this.descriptor.id}: shim close failed (${safeErrorText(error)})`)
    })
  }

  status(): ProviderStatus {
    return buildTraeStatus({
      providerId: this.descriptor.id,
      region: this.region,
      label: this.descriptor.label,
      snapshot: this.snapshot,
      prefs: this.prefs,
    })
  }

  async refreshAll(): Promise<void> {
    if (this.disposed || this.snapshot.accounts.length === 0) return
    await this.refreshCatalogWithState().catch(error => {
      this.deps.log.warn(`${this.descriptor.id}: catalog refresh failed (${safeErrorText(error)})`)
    })
    await this.refreshUsage().catch(error => {
      this.deps.log.warn(`${this.descriptor.id}: usage refresh failed (${safeErrorText(error)})`)
    })
  }

  async action(action: HubAction): Promise<ProviderActionResult> {
    switch (action.type) {
      case 'refresh-account':
        return await this.refreshAccount()
      case 'refresh-catalog': {
        try {
          const result = await this.refreshCatalogWithState()
          return { message: `模型目录已刷新（${String(result.models)} 个模型）`, code: 'catalog-refreshed', params: { count: result.models } }
        } catch (error: unknown) {
          if (error instanceof ProviderActionError) throw error
          throw new ProviderActionError('catalog_refresh_failed', safeErrorText(error))
        }
      }
      case 'refresh-usage': {
        if (this.snapshot.accounts.length === 0) {
          throw new ProviderActionError('not_configured', '未找到 Trae 登录，请先在 Trae 桌面端登录')
        }
        const before = this.identity.capture()
        await this.refreshUsage()
        if (!this.identity.isCurrent(before)) {
          throw new ProviderActionError('stale_identity', '账号已切换，已丢弃旧账号的额度结果')
        }
        if (this.snapshot.creditsError !== undefined) {
          throw new ProviderActionError('usage_refresh_failed', '额度刷新失败，请稍后重试')
        }
        return { message: '额度已刷新', code: 'usage-refreshed' }
      }
      case 'checkin': {
        try {
          const result = await this.claimCheckin(action.accountId)
          return {
            message: result.message,
            ...result.code === undefined ? {} : { code: result.code },
            ...result.params === undefined ? {} : { params: result.params },
            data: { state: result.state, claimed: result.claimed },
          }
        } catch (error: unknown) {
          throw new ProviderActionError('checkin_failed', safeErrorText(error))
        }
      }
      case 'set-checkin':
        return await this.setCheckin(action.enabled, action.minute)
      case 'clear-checkin-log':
        await this.commitPrefs({ ...this.prefs, checkin: { ...this.prefs.checkin, log: [] } })
        this.notify()
        return { message: '签到记录已清空', code: 'checkin-log-cleared' }
      case 'select-account':
        return await this.selectAccount(action.accountId)
      case 'set-model-enabled':
        return await this.setModelsEnabled([action.modelId], action.enabled)
      case 'set-models-enabled':
        return await this.setModelsEnabled(action.modelIds, action.enabled)
      case 'set-max-context':
        await this.commitPrefs({ ...this.prefs, useMaxContext: action.useMax })
        this.applyCatalog(true)
        this.notify()
        return {
          message: action.useMax ? '已切换为最大上下文窗口' : '已切换为默认上下文窗口',
          code: action.useMax ? 'max-context-on' : 'max-context-off',
        }
      case 'set-probe-consent':
        await this.commitPrefs({ ...this.prefs, probeConsent: action.consent })
        this.notify()
        return {
          message: action.consent ? '已开启推理档位探测' : '已关闭推理档位探测',
          code: action.consent ? 'probe-consent-on' : 'probe-consent-off',
        }
      case 'probe-model':
        return await this.probeSingleModel(action.modelId)
      case 'test-models':
        return await this.testModels(action.modelIds)
      case 'transfer-preview':
        return { data: previewTransferOf(action.text) }
      case 'transfer-import':
        return await this.importTransfer(action.text, action.accountIds)
      case 'transfer-export':
        return await this.exportTransfer(action.accountIds)
      default:
        return {}
    }
  }

  private requireStore(): TraeCredentialStore {
    if (this.store === undefined) throw new Error('Trae 凭证存储尚未初始化')
    return this.store
  }

  private requireSoloClient(): TraeSoloUpstreamClient {
    if (this.soloClient === undefined) throw new Error('Trae 上游客户端尚未初始化')
    return this.soloClient
  }

  /** Load this region's preferences from the hub preference store. */
  private async loadPreferences(): Promise<TraePrefs> {
    return parseTraePrefs(await this.deps.prefs.get<unknown>(this.prefsKey))
  }

  private createStore(): TraeCredentialStore {
    const persist = new VaultTraeCredentialPersistence(
      this.deps.vault,
      TRAE_VAULT_SLOTS[this.region],
    )
    return new TraeCredentialStore({
      region: this.region,
      persist,
      refresh: async credential => refreshTraeCredential(credential, undefined, await this.refreshDeviceSafe()),
    })
  }

  private async resolveIdentity(): Promise<TraeIdentity> {
    let preferred: TraeEdition | undefined
    try {
      preferred = (await this.requireStore().current())?.edition
    } catch {
      preferred = undefined
    }
    const candidates = traeStorageCandidates().filter(candidate => candidate.source === 'desktop'
      && (preferred !== undefined ? candidate.edition === preferred : regionOfEdition(candidate.edition) === this.region))
    const cliEdition: TraeEdition = preferred ?? (this.region === 'ai' ? 'solo-sg' : 'cn')
    return resolveTraeIdentity(candidates, cliEdition)
  }

  private async refreshDeviceSafe(): Promise<TraeRefreshDevice | undefined> {
    try {
      const identity = await this.resolveIdentity()
      return {
        deviceId: identity.deviceId,
        machineId: identity.machineId,
        ...identity.deviceName === undefined ? {} : { deviceName: identity.deviceName },
        ...identity.deviceModel === undefined ? {} : { deviceModel: identity.deviceModel },
        ...identity.deviceBrand === undefined ? {} : { deviceBrand: identity.deviceBrand },
        ...identity.deviceCpu === undefined ? {} : { deviceCpu: identity.deviceCpu },
        ...identity.osVersion === undefined ? {} : { osVersion: identity.osVersion },
        ...identity.appVersion === undefined ? {} : { appVersion: identity.appVersion },
        ...identity.deviceKeyPair === undefined ? {} : { deviceKeyPair: identity.deviceKeyPair },
      }
    } catch {
      return undefined
    }
  }

  private async deviceIdSafe(): Promise<string | undefined> {
    try {
      return (await this.resolveIdentity()).deviceId
    } catch {
      return undefined
    }
  }

  private usageClientFor(credential: TraeCredential): TraeUsageClient {
    return new TraeUsageClient({ credential: async () => credential, deviceId: () => this.deviceIdSafe() })
  }

  private shimLogger(): ShimLogger {
    const log = this.deps.log.child('shim')
    return {
      warn: (...args: unknown[]) => {
        log.warn(args.map(describeLogArg).join(' '))
      },
      error: (...args: unknown[]) => {
        log.error(args.map(describeLogArg).join(' '))
      },
    }
  }

  private wireTargetOf(displayId: string): TraeWireTarget | undefined {
    return this.wireById.get(displayId) ?? this.wireByName.get(displayId.trim().toLowerCase())
  }

  private applyCatalog(announce: boolean): void {
    // No usable account = no served rows: fallback models would only offer
    // calls that are guaranteed to fail. A credential whose live fetch has not
    // succeeded keeps the fallback roster (see servedModelsOf).
    const visible = this.snapshot.accounts.length > 0 && this.snapshot.current !== undefined
    this.catalog.setVisible(visible)
    const served = servedModelsOf(this.snapshot.catalog, this.prefs, this.region)
    try {
      this.catalog.set(served)
    } catch (error: unknown) {
      this.deps.log.warn(`${this.descriptor.id}: cannot apply model catalog (${safeErrorText(error)})`)
      return
    }
    this.adapter?.invalidate()
    if (!announce) return
    try {
      this.registration?.replace([this.descriptor.id])
    } catch (error: unknown) {
      this.deps.log.warn(`${this.descriptor.id}: adapter re-registration failed (${safeErrorText(error)})`)
    }
    try {
      this.deps.ctx.emit('llm/adapters-updated')
    } catch (error: unknown) {
      this.deps.log.warn(`${this.descriptor.id}: adapter update notification failed (${safeErrorText(error)})`)
    }
  }

  /**
   * Re-read the local account list. Returns true when the active identity
   * changed, in which case every cached financial value of the previous
   * account is dropped before it can be shown against the new one.
   */
  private async syncAccounts(): Promise<boolean> {
    const store = this.requireStore()
    try {
      const [accounts, current] = await Promise.all([store.accounts(), store.current()])
      const initialScan = !this.syncedAccounts
      this.syncedAccounts = true
      this.snapshot.accounts = accounts
      if (current === undefined) delete this.snapshot.current
      else this.snapshot.current = current
      const identity = current === undefined ? undefined : traeAccountId(current)
      const previous = this.identity.current()
      if (!this.identity.update(identity)) return false
      this.clearAccountScopedState()
      // The served roster and its wire ids belong to the account that fetched
      // them, so an account transition drops them before visibility is
      // reapplied. The very first scan keeps the region cache: it is the
      // bootstrap roster for the account that is already signed in at startup.
      if (!initialScan || previous !== undefined) this.resetCatalogForAccountChange()
      // Visibility follows the account list immediately, not just on the next
      // catalog refresh: signing in must make the roster servable, and signing
      // out (or losing the selected account) must stop serving it. This keeps
      // status().catalog and the adapter/shim catalog in agreement.
      // Announce only once the route is registered; init() re-applies and
      // announces after the adapter exists.
      this.applyCatalog(this.adapter !== undefined)
      return true
    } catch (error: unknown) {
      this.snapshot.hardError = `读取 Trae 登录状态失败：${safeErrorText(error)}`
      return false
    }
  }

  /** Drop the account-scoped roster while keeping the region bootstrap. */
  private resetCatalogForAccountChange(): void {
    this.wireById.clear()
    this.wireByName.clear()
    this.snapshot.catalog = fallbackModelsFor(this.region)
    this.snapshot.catalogSource = 'builtin'
    delete this.snapshot.catalogUpdatedAt
    delete this.snapshot.catalogError
  }

  /** Credits/hard errors belong to one account; never carry them across a switch. */
  private clearAccountScopedState(): void {
    delete this.snapshot.credits
    delete this.snapshot.creditsUpdatedAt
    delete this.snapshot.creditsError
    delete this.snapshot.hardError
  }

  private async commitPrefs(next: TraePrefs): Promise<void> {
    this.prefs = next
    try {
      await this.deps.prefs.set(this.prefsKey, next)
    } catch (error: unknown) {
      this.deps.log.warn(`${this.descriptor.id}: cannot persist preferences (${safeErrorText(error)})`)
    }
  }

  private notify(): void {
    if (!this.disposed) this.deps.notifyChanged()
  }

  private async refreshAccount(): Promise<ProviderActionResult> {
    let identityChanged = await this.syncAccounts()
    const store = this.requireStore()
    const count = this.snapshot.accounts.length
    let tokenNote = ''
    let failed: string | undefined
    if (count > 0) {
      // Re-read the local sign-in AND give the token lifecycle a chance to run:
      // `resolve()` rotates the access token when it is near expiry, which is
      // what keeps a live account usable without waiting for the next chat.
      try {
        const before = (await store.current())?.accessToken
        const credential = await store.resolve()
        if (await this.syncAccounts()) identityChanged = true
        delete this.snapshot.hardError
        if (credential.accessToken !== before) tokenNote = '，登录令牌已自动更新'
      } catch (error: unknown) {
        failed = `Trae 登录已失效，请在 Trae 桌面端重新登录（${safeErrorText(error)}）`
        this.snapshot.hardError = failed
      }
    }
    if (identityChanged) {
      // A rescan can reveal a different local sign-in; refresh the new
      // account's roster and quota instead of waiting for the next interval.
      this.usageFlight = new SingleFlight<void>()
      if (count > 0 && this.snapshot.current !== undefined) {
        void this.refreshCatalogWithState().catch(error => {
          this.deps.log.warn(`${this.descriptor.id}: catalog refresh after account change failed (${safeErrorText(error)})`)
        })
      }
      void this.refreshUsage().catch(error => {
        this.deps.log.warn(`${this.descriptor.id}: usage refresh after account change failed (${safeErrorText(error)})`)
      })
    } else if (failed === undefined && count > 0 && this.snapshot.current !== undefined && this.snapshot.catalogSource !== 'live') {
      // The startup cache (or a roster left over from a failed first fetch) may
      // predate the account now in the store: the Trae app can sign in while
      // the plugin was not running. "重新读取账号" must repair that roster
      // instead of reporting success over a list this account never fetched.
      void this.refreshCatalogWithState().catch(error => {
        this.deps.log.warn(`${this.descriptor.id}: catalog refresh after account rescan failed (${safeErrorText(error)})`)
      })
    }
    this.notify()
    if (failed !== undefined) throw new ProviderActionError('credential_unusable', failed)
    if (count === 0) {
      throw new ProviderActionError('not_configured', '未找到 Trae 登录，请先在 Trae 桌面端登录')
    }
    return {
      message: `已读取登录状态：发现 ${String(count)} 个账号${tokenNote}`,
      code: 'accounts-read',
      params: { count },
      data: { accounts: count, tokenRefreshed: tokenNote !== '' },
    }
  }

  private async selectAccount(accountId: string): Promise<ProviderActionResult> {
    await this.syncAccounts()
    const account = this.snapshot.accounts.find(item => item.id === accountId)
    if (account === undefined) throw new ProviderActionError('unknown_account', '账号不存在，请重新读取账号后再选择')
    const store = this.requireStore()
    const next: TraePrefs = { ...this.prefs }
    if (accountId === '') delete next.selectedAccountId
    else next.selectedAccountId = accountId
    await this.commitPrefs(next)
    store.selectAccount(accountId)
    const switched = await this.syncAccounts()
    // Start from a clean single-flight: joining the previous account's usage
    // read would publish (and report) the wrong account's answer.
    this.usageFlight = new SingleFlight<void>()
    if (switched && this.snapshot.current !== undefined) {
      // Select-account changes which roster is callable; fetch the new
      // account's directory rather than leaving the old one until a manual
      // refresh.
      void this.refreshCatalogWithState().catch(error => {
        this.deps.log.warn(`${this.descriptor.id}: catalog refresh after account switch failed (${safeErrorText(error)})`)
      })
    }
    this.notify()
    void this.refreshUsage().catch(error => {
      this.deps.log.warn(`${this.descriptor.id}: usage refresh after account switch failed (${safeErrorText(error)})`)
    })
    return { message: `已切换到账号 ${maskAccountName(account.accountName)}`, code: 'account-switched', params: { account: maskAccountName(account.accountName) } }
  }

  private async setModelsEnabled(modelIds: readonly string[], enabled: boolean): Promise<ProviderActionResult> {
    if (modelIds.length === 0) return { message: '没有需要修改的模型' }
    const next: TraePrefs = { ...this.prefs, modelEnabled: { ...this.prefs.modelEnabled } }
    for (const id of modelIds) next.modelEnabled[id] = enabled
    await this.commitPrefs(next)
    this.applyCatalog(true)
    this.notify()
    return {
      message: enabled ? `已启用 ${String(modelIds.length)} 个模型` : `已停用 ${String(modelIds.length)} 个模型`,
      code: enabled ? 'models-enabled' : 'models-disabled',
      params: { count: modelIds.length },
    }
  }

  private async setCheckin(enabled: boolean | undefined, minute: number | undefined): Promise<ProviderActionResult> {
    const next: TraePrefs = {
      ...this.prefs,
      checkin: {
        ...this.prefs.checkin,
        ...enabled === undefined ? {} : { enabled },
        ...minute === undefined ? {} : { minute },
      },
    }
    await this.commitPrefs(next)
    this.scheduleCheckin()
    this.notify()
    const state = enabled ?? this.prefs.checkin.enabled
    const at = minute ?? this.prefs.checkin.minute
    const hh = String(Math.floor(at / 60)).padStart(2, '0')
    const mm = String(at % 60).padStart(2, '0')
    if (enabled === undefined && minute !== undefined) {
      return { message: `签到时间已设为 ${hh}:${mm}（UTC+8）`, code: 'checkin-time-set', params: { time: `${hh}:${mm}` } }
    }
    return {
      message: state ? `自动签到已开启，每天 ${hh}:${mm}（UTC+8）` : '自动签到已关闭',
      code: state ? 'checkin-schedule-on' : 'checkin-schedule-off',
      ...state ? { params: { time: `${hh}:${mm}` } } : {},
    }
  }

  private scheduleUsageRefresh(): void {
    this.deps.scheduler.every(`${this.descriptor.id}:usage`, TRAE_USAGE_REFRESH_INTERVAL_MS, async () => {
      if (this.disposed || this.snapshot.accounts.length === 0) return
      await this.refreshUsage().catch(error => {
        this.deps.log.warn(`${this.descriptor.id}: periodic usage refresh failed (${safeErrorText(error)})`)
      })
    })
  }

  private scheduleCheckin(): void {
    this.deps.scheduler.clear(`${this.descriptor.id}:checkin`)
    if (!this.prefs.checkin.enabled) return
    this.deps.scheduler.atUtc8Minute(`${this.descriptor.id}:checkin`, this.prefs.checkin.minute, async () => {
      if (this.disposed || !this.prefs.checkin.enabled) return
      await this.runScheduledCheckin()
    })
  }

  private async runScheduledCheckin(): Promise<void> {
    const at = Date.now()
    try {
      await this.claimCheckin(undefined)
    } catch (error: unknown) {
      const message = safeErrorText(error)
      await this.logCheckinRow({
        at,
        ok: false,
        message,
        code: 'checkin-failed-reason',
        params: { reason: message },
      })
      this.deps.log.warn(`${this.descriptor.id}: scheduled check-in failed (${message})`)
    } finally {
      await this.commitPrefs({ ...this.prefs, checkin: { ...this.prefs.checkin, lastRunAt: at } })
      this.notify()
    }
  }

  private async logCheckinRow(row: CheckinLogRow): Promise<void> {
    await this.commitPrefs(withCheckinLog(this.prefs, row))
  }

  private selectedAccountId(): string | undefined {
    return this.snapshot.accounts.find(account => account.selected)?.id
      ?? this.prefs.selectedAccountId
  }

  private setCheckinSnapshot(accountId: string, snapshot: TraeCheckinSnapshot): void {
    this.snapshot.checkinByAccount = { ...this.snapshot.checkinByAccount, [accountId]: snapshot }
  }

  private async claimCheckin(accountId: string | undefined): Promise<{
    state: CheckinState
    claimed: boolean
    message: string
    code?: string
    params?: { reward: number }
  }> {
    if (this.region !== 'cn') {
      return { state: 'unknown', claimed: false, message: '国际版不提供每日签到' }
    }
    const target = accountId ?? this.selectedAccountId()
    if (target === undefined) return { state: 'unknown', claimed: false, message: '请先选择一个账号' }
    const credential = await this.requireStore().credentialOf(target)
    if (credential === undefined) throw new Error('账号不存在或登录已失效，请重新读取账号')
    const current = await this.requireStore().current()
    const client = current !== undefined && traeAccountId(current) === target
      ? (this.usageClient ?? this.usageClientFor(credential))
      : this.usageClientFor(credential)
    let before: TraeCheckinStatus
    try {
      before = await client.checkinStatus()
    } catch (error: unknown) {
      const message = `读取签到状态失败：${safeErrorText(error)}`
      this.setCheckinSnapshot(target, errorCheckinSnapshot(Date.now(), error))
      this.notify()
      throw new Error(message)
    }
    this.setCheckinSnapshot(target, checkinSnapshotOf(before))
    const preflight = checkinPreflight(before)
    if (preflight.action === 'skip') {
      await this.logCheckinRow({
        at: Date.now(),
        ok: preflight.state === 'claimed',
        message: preflight.message,
        ...preflight.code === undefined ? {} : { code: preflight.code },
      })
      this.notify()
      return {
        state: preflight.state,
        claimed: false,
        message: preflight.message,
        ...preflight.code === undefined ? {} : { code: preflight.code },
      }
    }
    const claim = await client.claimCheckin()
    const after = await client.checkinStatus().catch(() => before)
    this.setCheckinSnapshot(target, checkinSnapshotOf(after))
    const outcome = checkinClaimOutcome(claim, after, TRAE_CHECKIN_DEVICE_CLAIMED_CODE)
    await this.logCheckinRow({
      at: Date.now(),
      ok: outcome.claimed,
      message: outcome.message,
      ...outcome.code === undefined ? {} : { code: outcome.code },
      ...outcome.params === undefined ? {} : { params: outcome.params },
    })
    this.notify()
    return outcome
  }

  private modelKeys(): Set<string> {
    const keys = new Set<string>()
    for (const model of [...this.snapshot.catalog, ...this.catalog.current()]) {
      keys.add(model.id.trim().toLowerCase())
      keys.add(model.name.trim().toLowerCase())
    }
    return keys
  }

  private async probeSingleModel(modelId: string): Promise<ProviderActionResult> {
    if (!this.prefs.probeConsent) throw new ProviderActionError('probe_forbidden', '未开启推理档位探测授权，探测会消耗额度')
    const model = this.snapshot.catalog.find(item => item.id === modelId)
      ?? this.snapshot.catalog.find(item => item.name === modelId)
    if (model === undefined) throw new ProviderActionError('unknown_model', '模型不在当前目录中，无法探测')
    const result = await this.probeModelsSequentially([model.id])
    const view = probeViewOf(result[0]!, model)
    await this.storeProbeViews([view])
    return { message: `已探测 ${model.name}`, code: 'probe-done', params: { model: model.name }, data: { probe: view } }
  }

  private async testModels(modelIds: readonly string[]): Promise<ProviderActionResult> {
    if (!this.prefs.probeConsent) throw new ProviderActionError('probe_forbidden', '未开启推理档位探测授权，探测会消耗额度')
    if (modelIds.length === 0) throw new ProviderActionError('invalid_request', '没有需要探测的模型')
    if (modelIds.length > TRAE_MODELS_TEST_LIMIT) throw new ProviderActionError('invalid_request', `一次最多探测 ${String(TRAE_MODELS_TEST_LIMIT)} 个模型`)
    const known = this.modelKeys()
    const testable: string[] = []
    const skipped: string[] = []
    for (const id of modelIds) {
      const key = id.trim().toLowerCase()
      if (known.has(key)) testable.push(id)
      else skipped.push(id)
    }
    const results = await this.probeModelsSequentially(testable)
    const views = results.map(result => probeViewOf(result, this.modelOf(result.id)))
    await this.storeProbeViews(views)
    return {
      message: `已探测 ${String(views.length)} 个模型${skipped.length === 0 ? '' : `，跳过 ${String(skipped.length)} 个未知模型`}`,
      code: skipped.length === 0 ? 'models-probed' : 'models-probed-skipped',
      params: skipped.length === 0 ? { count: views.length } : { count: views.length, skipped: skipped.length },
      data: { results: views, ...skipped.length === 0 ? {} : { skipped } },
    }
  }

  private modelOf(id: string): TraeModelInfo | undefined {
    return this.snapshot.catalog.find(model => model.id === id)
      ?? this.snapshot.catalog.find(model => model.name === id)
  }

  private async probeModelsSequentially(ids: readonly string[]): Promise<TraeProbeResult[]> {
    const bridge = this.bridge
    if (bridge === undefined) throw new Error('Trae 上游尚未就绪')
    return probeModelsSequentially((body, signal) => bridge.chatStream(body, signal), ids)
  }

  private async storeProbeViews(views: readonly ProbeView[]): Promise<void> {
    const probes = { ...this.prefs.probes }
    for (const view of views) {
      probes[view.modelId] = {
        modelId: view.modelId,
        state: view.state,
        efforts: [...view.efforts],
        ...view.message === undefined ? {} : { message: view.message },
        ...view.at === undefined ? {} : { at: view.at },
      }
    }
    await this.commitPrefs({ ...this.prefs, probes })
    this.notify()
  }

  private async importTransfer(text: string, accountIds: readonly string[]): Promise<ProviderActionResult> {
    const records = parseTransferFile(text)
    const indexes = transferIndexesOf(accountIds, records.length)
    if (indexes.length === 0) throw new ProviderActionError('invalid_request', '请先选择要导入的账号')
    const { changes, imported, skipped } = mergeTransferRecords(records, indexes, this.region)
    let selected: string | undefined
    if (changes.size > 0) {
      const written = await this.requireStore().importAccounts([...changes.values()])
      selected = written[written.length - 1]
      if (selected !== undefined) {
        await this.commitPrefs({ ...this.prefs, selectedAccountId: selected })
      }
      await this.syncAccounts()
    }
    this.notify()
    return {
      message: imported === 0
        ? `没有可导入的账号（跳过 ${String(skipped)} 个）`
        : `已导入 ${String(imported)} 个账号${skipped === 0 ? '' : `，跳过 ${String(skipped)} 个`}`,
      ...imported === 0
        ? { code: 'accounts-none-imported', params: { skipped } }
        : skipped === 0
          ? { code: 'accounts-imported', params: { count: imported } }
          : { code: 'accounts-imported-skipped', params: { count: imported, skipped } },
      data: { imported, skipped },
    }
  }

  private async exportTransfer(accountIds: readonly string[]): Promise<ProviderActionResult> {
    const store = this.requireStore()
    const wanted = new Set(accountIds)
    if (wanted.size === 0) {
      const selected = this.selectedAccountId()
      if (selected !== undefined) wanted.add(selected)
    }
    if (wanted.size === 0) throw new ProviderActionError('invalid_request', '请先选择要导出的账号')
    const credentials: TraeCredential[] = []
    for (const accountId of wanted) {
      const credential = await store.credentialOf(accountId).catch(() => undefined)
      if (credential !== undefined) credentials.push(credential)
    }
    if (credentials.length === 0) throw new ProviderActionError('invalid_request', '没有可导出的账号')
    return {
      message: `已导出 ${String(credentials.length)} 个账号`,
      code: 'accounts-exported',
      params: { count: credentials.length },
      // The one action that deliberately returns credential material.
      data: transferExportOf(this.region, credentials),
    }
  }

  private async refreshCatalogWithState(): Promise<{ models: number; updatedAt: number }> {
    try {
      const result = await this.refreshCatalog()
      delete this.snapshot.catalogError
      this.notify()
      return result
    } catch (error: unknown) {
      if (error instanceof ProviderActionError) {
        // A stale-identity discard is not a catalog failure: there is no new
        // error to report, and the caller must see the stable code so the UI
        // does not claim success.
        this.notify()
        throw error
      }
      this.snapshot.catalogError = safeErrorText(error)
      this.notify()
      throw new Error(this.snapshot.catalogError)
    }
  }

  private refreshCatalog(): Promise<{ models: number; updatedAt: number }> {
    return this.catalogFlight.run(async () => {
      const store = this.requireStore()
      // A local sign-in can change without going through the catalog action
      // (the Trae app owns those files). Reconcile first so the stamp always
      // names the credential the fetch will actually use.
      await this.syncAccounts()
      const stamp = this.identity.capture()
      const current = await store.current()
      if (current === undefined) {
        throw new ProviderActionError('not_configured', '未找到 Trae 登录，无法刷新模型目录')
      }
      const currentId = traeAccountId(current)
      if (stamp.identity !== currentId) {
        // The guard has not caught up with the store; fetching now would use
        // one account and publish under another.
        throw new ProviderActionError('stale_identity', '账号已切换，已丢弃过期的模型目录结果')
      }
      const remoteCatalog = this.remoteCatalog
      const soloClient = this.requireSoloClient()
      if (remoteCatalog === undefined) throw new Error('Trae 模型目录客户端尚未就绪')
      const remote = await withDirectoryRetry(() => remoteCatalog.fetchModels())
      const wireModels = await soloClient.fetchModels()
      const merged = mergeTraeModelSources(remote, wireModels)
      if (merged.length === 0) throw new Error('Trae 目录没有返回任何模型')
      // The roster is account-scoped. Check the guard AND re-read the store at
      // publish time: a slow read from the previous account must never replace
      // the current one's directory, and an external sign-in can move the
      // store without the guard seeing it.
      const latest = await store.current().catch(() => undefined)
      if (this.disposed
        || !this.identity.isCurrent(stamp)
        || latest === undefined
        || traeAccountId(latest) !== currentId) {
        if (!this.disposed) await this.syncAccounts()
        throw new ProviderActionError('stale_identity', '账号已切换，已丢弃过期的模型目录结果')
      }
      this.wireById.clear()
      this.wireByName.clear()
      for (const model of merged) {
        if (model.wireConfigName === undefined) continue
        const target: TraeWireTarget = {
          configName: model.wireConfigName,
          ...model.wireFunction === undefined ? {} : { function: model.wireFunction },
        }
        this.wireById.set(model.id, target)
        this.wireByName.set(model.name.trim().toLowerCase(), target)
      }
      const updatedAt = Date.now()
      this.snapshot.catalog = merged
      this.snapshot.catalogSource = 'live'
      this.snapshot.catalogUpdatedAt = updatedAt
      // Publish to status() and the adapter/shim in the same synchronous turn;
      // the cache write below must not open a window where status already shows
      // the new roster while the served catalog still has the old one.
      this.applyCatalog(true)
      await saveTraeCatalogCache(this.deps.paths.stateDir, this.region, merged, updatedAt).catch(error => {
        this.deps.log.warn(`${this.descriptor.id}: cannot persist the model catalog cache (${safeErrorText(error)})`)
      })
      return { models: merged.length, updatedAt }
    })
  }

  private refreshUsage(): Promise<void> {
    return this.usageFlight.run(async () => {
      const store = this.requireStore()
      const usageClient = this.usageClient
      if (usageClient === undefined) return
      const stamp = this.identity.capture()
      let current: TraeCredential | undefined
      try {
        current = await store.current()
      } catch (error: unknown) {
        if (!this.identity.isCurrent(stamp)) return
        this.snapshot.creditsError = safeErrorText(error)
        this.notify()
        return
      }
      if (current === undefined) {
        // The Trae app owns its login files, so an external sign-out can reach
        // this observer without any hub action. Reconcile through
        // syncAccounts() — the same transition every explicit action uses — so
        // the account list, the guard and the served roster move together;
        // returning here would keep the route ready with the previous
        // account's models and credits.
        await this.syncAccounts()
        this.snapshot.creditsError = '未找到 Trae 登录'
        this.notify()
        return
      }
      const currentId = traeAccountId(current)
      // The store can change under us without the caller going through
      // selectAccount/refreshAccount. Route that transition through
      // syncAccounts() instead of only adopting the guard identity: it also
      // resets the account-scoped roster/wire maps, clears the previous
      // account's credits and reapplies visibility, so status().catalog and
      // the adapter/shim roster agree before this read can publish anything.
      // The same-account path keeps its old behaviour (no extra account scan).
      let identityChanged = false
      if (this.identity.current() !== currentId) {
        identityChanged = true
        await this.syncAccounts()
        if (this.identity.current() === undefined) {
          // A sign-out raced the account read above; syncAccounts already hid
          // the catalog and dropped the previous account's credits.
          this.snapshot.creditsError = '未找到 Trae 登录'
          this.notify()
          return
        }
        if (this.identity.current() !== currentId) {
          // The store moved again between the read and the sync; a later refresh
          // will serve the new account. Publishing now would attribute this
          // answer to the wrong one.
          return
        }
      }
      const active = this.identity.capture()
      if (identityChanged) {
        // The account changed, so the previous account's roster is gone. Fetch
        // the new account's directory immediately instead of waiting for the
        // next interval.
        void this.refreshCatalogWithState().catch(error => {
          this.deps.log.warn(`${this.descriptor.id}: catalog refresh after account change failed (${safeErrorText(error)})`)
        })
      }

      /** Publish only while `active` still names the account in the store. */
      const stillCurrent = async (): Promise<boolean> => {
        if (this.disposed || !this.identity.isCurrent(active)) return false
        const latest = await store.current().catch(() => undefined)
        return latest !== undefined && traeAccountId(latest) === currentId
      }

      const now = Date.now()
      if (this.region === 'ai') {
        try {
          const payStatus = await usageClient.payStatus()
          if (!await stillCurrent()) return
          this.snapshot.credits = creditsViewOfPayStatus(payStatus, now)
          this.snapshot.creditsUpdatedAt = now
          delete this.snapshot.creditsError
          delete this.snapshot.hardError
        } catch (error: unknown) {
          if (!await stillCurrent()) return
          this.snapshot.creditsError = safeErrorText(error)
          if (isAuthenticationFailure(error)) this.snapshot.hardError = this.snapshot.creditsError
        }
        // The usage client resolves through the credential store, so a token
        // rotation may have happened; publish the fresh copy to `status()`.
        await this.syncAccounts()
        this.notify()
        return
      }
      const [snapshotResult, checkinResult] = await Promise.allSettled([usageClient.snapshot(), usageClient.checkinStatus()])
      if (!await stillCurrent()) return
      if (snapshotResult.status === 'fulfilled') {
        this.snapshot.credits = creditsViewOfSnapshot(snapshotResult.value, now)
        this.snapshot.creditsUpdatedAt = now
        delete this.snapshot.creditsError
        delete this.snapshot.hardError
      } else {
        this.snapshot.creditsError = safeErrorText(snapshotResult.reason)
        if (isAuthenticationFailure(snapshotResult.reason)) this.snapshot.hardError = this.snapshot.creditsError
      }
      if (checkinResult.status === 'fulfilled') this.setCheckinSnapshot(currentId, checkinSnapshotOf(checkinResult.value, now))
      else this.setCheckinSnapshot(currentId, errorCheckinSnapshot(now, checkinResult.reason))
      await this.syncAccounts()
      const others = this.snapshot.accounts.filter(account => account.id !== currentId).slice(0, TRAE_ACCOUNT_READ_LIMIT)
      await Promise.all(others.map(async account => {
        const credential = await store.credentialOf(account.id).catch(() => undefined)
        if (credential === undefined) return
        try {
          const status = await this.usageClientFor(credential).checkinStatus()
          this.setCheckinSnapshot(account.id, checkinSnapshotOf(status, now))
        } catch (error: unknown) {
          this.setCheckinSnapshot(account.id, errorCheckinSnapshot(now, error))
        }
      }))
      this.notify()
    })
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /\b(401|403)\b|authentication|unauthorized|forbidden|登录|令牌/i.test(text)
}
