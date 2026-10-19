import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  HubAction,
  ProviderStatus,
  WarningView,
} from '../../shared/contracts.ts'
import type {
  ProviderActionResult,
  ProviderDeps,
  ProviderDescriptor,
  ProviderRuntime,
} from '../../core/types.ts'
import { ProviderActionError } from '../../core/types.ts'
import type { HubLogger } from '../../core/log.ts'
import { writeTextFile } from '../../core/atomic.ts'
import { IdentityGuard } from '../../core/identity.ts'
import { redactText, stripInternalErrorMarkers } from '../../core/redact.ts'
import { FALLBACK_QODER_MODELS, QoderCatalog } from './catalog.ts'
import { QoderCatalogStore } from './catalog-store.ts'
import {
  QoderCredentialStore,
  type QoderCredential,
  type QoderDeviceCredential,
} from './credentials.ts'
import {
  readQoderDesktopAuth,
  refreshQoderDeviceToken,
  type QoderDesktopCredential,
  type QoderDesktopReadResult,
  type QoderDeviceRefreshOutcome,
} from './desktop-auth.ts'
import {
  applyCheckinResult,
  checkinMessage,
  checkinMessageCode,
  checkinViewOf,
  normalizeCheckInMinute,
  settledToday,
  shouldCatchUp,
} from './checkin.ts'
import { defaultPrefs, readPrefs, writePrefs, type QoderPrefs } from './prefs.ts'
import { createQoderAdapter, type QoderAdapter } from './adapter.ts'
import { createQoderShim, type QoderShim } from './shim.ts'
import { createQoderTransport, type QoderCheckInResult, type QoderTransport } from './qoder/transport/index.ts'
import { getMachineId, officialMachineIdPath } from './qoder/transport/machine-id.ts'
import { isQoderAuthRejection } from './qoder/errors.ts'
import { QoderUpstreamClient, validateApiKey, type QoderCredits } from './upstream.ts'
import { qoderLoggerFor, shimLoggerFor } from './logging.ts'
import { creditsViewOf, deviceAccountView, hubModelsOf } from './status.ts'
import { fetchQoderUserInfo } from './qoder/transport/user-info.ts'
import type { QoderVariant } from './variants.ts'

/** How often the vault is re-read for externally changed credentials. */
const CREDENTIAL_POLL_MS = 30_000
/** How often the quota answer is refreshed while signed in. */
const USAGE_POLL_MS = 300_000
/** Minimum delay before a catalog that is not live is fetched again. */
const CATALOG_RETRY_MS = 120_000
/** The contract's source vocabulary for the served catalog list. */
const BUILTIN_SOURCE = 'builtin' as const
/** How long a failed or absent desktop-login probe is not retried. */
const DESKTOP_DETECT_RETRY_MS = 5 * 60 * 1000
/** How often the credential sweep re-reads the desktop file for an account switch. */
const DESKTOP_MERGE_INTERVAL_MS = 60 * 1000
/** Warn this long before the desktop refresh token itself expires. */
const REFRESH_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000
/** Deadline for the token validation read done when a desktop sign-in is adopted. */
const DESKTOP_VALIDATE_TIMEOUT_MS = 15_000

interface AttachmentFacade extends Pick<AttachmentStore, 'imageLimits' | 'readImageRequest' | 'saveImage'> {}

const ATTACHMENT_UNAVAILABLE = 'qoder: no attachment service is available'

function createAttachmentFacade(resolve: () => AttachmentStore | undefined): AttachmentFacade {
  const service = (): AttachmentStore => {
    const resolved = resolve()
    if (resolved === undefined) throw new Error(ATTACHMENT_UNAVAILABLE)
    return resolved
  }
  return {
    get imageLimits() { return service().imageLimits },
    readImageRequest: async (attachment, target, signal) => await service().readImageRequest(attachment, target, signal),
    saveImage: async request => await service().saveImage(request),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readText(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** Whether a failure means the credential itself is unusable. */
function isCredentialFailure(error: unknown): boolean {
  if (error instanceof LlmError) {
    return error.code === 'MISSING_CREDENTIAL' || isQoderAuthRejection(error)
  }
  return errorText(error).includes('MISSING_CREDENTIAL')
}

type DesktopFailure = Exclude<QoderDesktopReadResult, { state: 'found' }>

/** The user-facing sentence for a desktop probe that found no usable sign-in. */
function desktopFailureMessage(result: DesktopFailure, app: string): string {
  if (result.state === 'absent') {
    return `未找到 ${app} 桌面端登录记录；请先在 ${app} 桌面端登录一次，或填写 PAT`
  }
  if (result.state === 'unsupported') {
    return '当前平台暂不支持读取 Qoder 桌面端登录；请填写 PAT'
  }
  return `${result.reason}；请检查 Qoder 桌面端登录状态后重试，或填写 PAT`
}

/** Stable action code for a failed explicit desktop import. */
function desktopFailureActionCode(result: DesktopFailure): string {
  if (result.state === 'absent') return 'desktop_login_not_found'
  if (result.state === 'unsupported') return 'desktop_login_unsupported'
  return 'desktop_login_unreadable'
}

/** Host warning code the UI localizes for a failed desktop probe. */
function desktopFailureWarningCode(result: DesktopFailure): string {
  if (result.state === 'absent') return 'no-credential'
  if (result.state === 'unsupported') return 'desktop-login-unsupported'
  return 'desktop-login-unreadable'
}

/** Format a minute of day as `HH:MM`. */
function formatMinute(minute: number): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, '0')
  const minutes = String(minute % 60).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** Injection seams for the desktop-sign-in probe (tests only). */
export interface QoderRuntimeOverrides {
  readDesktopAuth?: typeof readQoderDesktopAuth
}

/**
 * Run one background task without letting its failure become an unhandled
 * rejection: Node terminates the whole host process on those, so every
 * timer-driven or fire-and-forget refresh goes through here. Failures are
 * logged through the redacting hub logger and reported to the caller so
 * `status()` can surface them; only background work is swallowed — foreground
 * actions still propagate their errors.
 */
export function runBackgroundTask(options: {
  label: string
  log: HubLogger
  work: () => Promise<void>
  onError?: (error: unknown) => void
}): void {
  void Promise.resolve()
    .then(options.work)
    .catch((error: unknown) => {
      const message = redactText(errorText(error)).slice(0, 300)
      options.log.warn(`${options.label} 后台任务失败：${message}`)
      try {
        options.onError?.(error)
      } catch {
        // A reporting failure must never resurrect the rejection just handled.
      }
    })
}

/**
 * One Qoder deployment's runtime: its credential store, upstream client,
 * loopback shim, pi-ai adapter, catalog, usage cache and check-in schedule.
 *
 * The two deployments are fully independent — one having no credential, a bad
 * credential, or an unreachable endpoint never touches the other.
 */
class QoderProviderRuntime implements ProviderRuntime {
  readonly descriptor: ProviderDescriptor
  private readonly deps: ProviderDeps
  private readonly variant: QoderVariant
  private readonly readDesktopAuth: typeof readQoderDesktopAuth
  private readonly log: HubLogger
  private readonly store: QoderCredentialStore
  private readonly transport: QoderTransport
  private readonly client: QoderUpstreamClient
  private readonly catalog = new QoderCatalog(FALLBACK_QODER_MODELS)
  private readonly savedCatalogs: QoderCatalogStore
  private readonly attachments: AttachmentFacade
  private readonly timerPrefix: string
  private prefs: QoderPrefs = defaultPrefs()
  private shim: QoderShim | undefined
  private adapter: QoderAdapter | undefined
  private releaseAdapter: (() => void) | undefined
  private releaseDirectory: (() => void) | undefined
  private providerError: string | undefined
  private identity: string | undefined
  private catalogSource: 'live' | 'saved' | 'fallback' = 'fallback'
  private catalogFetchedAtMs: number | undefined
  private catalogError: string | undefined
  private lastCatalogFetchAtMs = 0
  private catalogFlight: Promise<void> | undefined
  private credits: QoderCredits | undefined
  private creditsError: string | undefined
  private creditsUpdatedAt = 0
  private usageFlight: Promise<void> | undefined
  /** Credential identity every async read is stamped with before it starts. */
  private readonly identityGuard = new IdentityGuard()
  private authFailure = false
  private disposed = false
  private machineId: string | undefined
  /** Why the last desktop probe found no usable sign-in; cleared on success. */
  private desktopLoginError: { code: string; message: string } | undefined
  /** Last probe time, so a missing desktop app is not re-probed on every sweep. */
  private lastDesktopProbeAt = 0
  private desktopProbeInFlight = false
  /** Rotates a desktop-imported pair through this region's refresh endpoint. */
  private readonly refreshDesktopPair = async (
    credential: QoderDeviceCredential,
    signal?: AbortSignal,
  ): Promise<QoderDeviceRefreshOutcome> => await refreshQoderDeviceToken({
    region: this.variant.upstreamRegion,
    refreshToken: credential.refreshToken,
    ...signal === undefined ? {} : { signal },
  })

  constructor(deps: ProviderDeps, variant: QoderVariant, overrides: QoderRuntimeOverrides = {}) {
    this.deps = deps
    this.variant = variant
    this.readDesktopAuth = overrides.readDesktopAuth ?? readQoderDesktopAuth
    this.log = deps.log.child(variant.id)
    this.timerPrefix = `qoder:${variant.id}`
    this.descriptor = {
      id: variant.id,
      family: 'qoder',
      region: variant.region,
      label: variant.label,
    }
    this.attachments = createAttachmentFacade(() => this.resolveAttachments())
    this.store = new QoderCredentialStore({
      vault: deps.vault,
      variant,
      refresh: (credential, signal) => this.refreshDesktopPair(credential, signal),
    })
    this.transport = createQoderTransport({
      region: variant.upstreamRegion,
      resolveAccessToken: () => this.store.accessToken(),
      refreshDeviceToken: () => this.store.rotate(),
      attachments: this.attachments,
      // Keep the machine-id seed inside the hub's state directory; the
      // official Qoder CLI's id is read first when it exists.
      resolveMachineId: () => this.machineId ?? getMachineId([officialMachineIdPath()]),
      logger: qoderLoggerFor(this.log),
      onJobTokenRefreshed: info => {
        this.log.info(`${variant.displayName} job token 已自动刷新（${new Date(info.at).toISOString()}）`)
      },
      onJobTokenRefreshFailed: info => {
        this.log.warn(`${variant.displayName} job token 刷新后仍被上游拒绝${info.status === undefined ? '' : `（HTTP ${info.status}）`}`)
      },
    })
    this.client = new QoderUpstreamClient({
      region: variant.upstreamRegion,
      providerId: variant.id,
      getPat: () => this.store.accessToken(),
      transport: this.transport,
      attachments: this.attachments,
    })
    this.savedCatalogs = new QoderCatalogStore({
      paths: deps.paths,
      region: variant.upstreamRegion,
      log: this.log,
    })
  }

  /**
   * A stable device id: the official Qoder CLI's when it exists, otherwise a
   * seed persisted in the hub's state directory through the private atomic
   * writer. Never written anywhere near `$HOME`.
   */
  private async ensureMachineId(): Promise<string> {
    const official = await readText(officialMachineIdPath())
    if (official !== undefined) return official
    const seedPath = join(this.deps.paths.stateDir, `.qoder-machine-id-${this.variant.id}`)
    const existing = await readText(seedPath)
    if (existing !== undefined) return existing
    const created = randomUUID()
    try {
      await writeTextFile(seedPath, created)
    } catch (error) {
      this.log.warn(`无法保存设备标识，本次运行使用临时标识：${errorText(error)}`)
    }
    return created
  }

  private resolveAttachments(): AttachmentStore | undefined {
    return this.deps.ctx.get('attachments')
  }

  async init(): Promise<void> {
    this.machineId = await this.ensureMachineId()
    this.prefs = await readPrefs(this.deps.prefs, this.variant.id)
    this.applyPrefs()
    await this.store.load()
    await this.savedCatalogs.load()
    this.adoptIdentity()
    await this.startProvider()
    this.startTimers()
    this.armCheckin()
    this.deps.notifyChanged()
    if (this.store.current() !== undefined) {
      this.runInBackground('catalog', () => this.refreshCatalog())
      this.runInBackground('usage', () => this.refreshUsage())
      this.maybeCatchUp()
    } else if (this.prefs.autoLogin) {
      // Background by design: opening the OS credential store can show a
      // one-time permission prompt, which must never delay Host boot. The
      // status flips to signed-in (or to a diagnosed warning) when it settles.
      this.runInBackground('desktop', () => this.autoImportDesktopLogin())
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.deps.scheduler.clear(`${this.timerPrefix}:credential-sweep`)
    this.deps.scheduler.clear(`${this.timerPrefix}:usage-poll`)
    this.deps.scheduler.clear(`${this.timerPrefix}:checkin`)
    this.releaseAdapter?.()
    this.releaseAdapter = undefined
    this.releaseDirectory?.()
    this.releaseDirectory = undefined
    this.adapter = undefined
    const shim = this.shim
    this.shim = undefined
    if (shim !== undefined) {
      try {
        await shim.close()
      } catch (error) {
        this.log.warn(`关闭本地回环端点失败：${errorText(error)}`)
      }
    }
    await this.savedCatalogs.flush()
  }

  status(): ProviderStatus {
    const now = Date.now()
    const credential = this.store.summary()
    const configured = credential.configured
    const current = this.store.current()
    const device = current !== undefined && current.kind === 'device' ? current : undefined
    const warnings: WarningView[] = []
    if (!configured) {
      if (this.desktopLoginError !== undefined) {
        warnings.push({
          code: this.desktopLoginError.code,
          level: 'info',
          message: this.desktopLoginError.message,
        })
      } else {
        warnings.push({
          code: this.prefs.autoLogin ? 'credential-reading' : 'credential-missing',
          level: 'info',
          message: this.prefs.autoLogin
            ? '正在读取 Qoder 桌面端登录；也可以手动填写 PAT'
            : '尚未登录 Qoder；请先在 Qoder 桌面端登录一次，或填写 PAT',
        })
      }
    } else if (this.authFailure) {
      warnings.push({
        code: device === undefined ? 'credential-rejected' : 'desktop-credential-rejected',
        level: 'error',
        message: device === undefined
          ? 'PAT 无效或已过期，请重新填写'
          : 'Qoder 桌面端登录已被拒绝，请重新读取或填写 PAT',
      })
    }
    const refreshExpired = credential.refreshExpiresAtMs !== undefined && credential.refreshExpiresAtMs <= now
    const tokenExpired = credential.expiresAtMs !== undefined && credential.expiresAtMs <= now
    if (device !== undefined) {
      const refreshError = this.store.lastRefreshError()
      if (refreshExpired) {
        warnings.push({
          code: 'refresh-expired',
          level: 'error',
          message: '桌面端登录的刷新令牌已过期，请在 Qoder 桌面端重新登录后重新读取',
        })
      } else if (refreshError !== undefined) {
        warnings.push({
          code: 'credential-error',
          level: 'warn',
          message: `桌面端登录自动续期失败：${redactText(refreshError)}`,
        })
      } else if (tokenExpired) {
        warnings.push({
          code: 'token-expired',
          level: 'warn',
          message: '桌面端登录令牌已过期，将在下次请求时自动续期；若持续失败请重新读取',
        })
      } else if (credential.refreshExpiresAtMs !== undefined
        && credential.refreshExpiresAtMs - now <= REFRESH_EXPIRY_WARNING_MS) {
        warnings.push({
          code: 'refresh-expiring',
          level: 'warn',
          message: '桌面端登录的刷新令牌即将过期，请打开一次 Qoder 桌面端',
        })
      }
    }
    if (this.providerError !== undefined) {
      warnings.push({ code: 'provider-unavailable', level: 'error', message: '模型服务注册失败，重启 DSH 后再试' })
    }
    if (this.catalogError !== undefined) {
      warnings.push({
        code: 'catalog-unavailable',
        level: 'warn',
        message: '模型目录刷新失败，继续显示上次的列表',
      })
    }
    if (this.creditsError !== undefined) {
      warnings.push({ code: 'usage-unavailable', level: 'warn', message: '额度刷新失败，请稍后重试' })
    }
    const unrecoverable = tokenExpired
      && (refreshExpired || credential.refreshExpiresAtMs === undefined)
    const state: ProviderStatus['state'] = !configured
      ? 'needs-credential'
      : this.authFailure || this.providerError !== undefined || unrecoverable
        ? 'error'
        : 'ready'
    const models = configured && this.providerError === undefined
      ? hubModelsOf(this.catalog, this.prefs.useMaxContext)
      : []
    const credits = this.credits === undefined
      ? undefined
      : { ...creditsViewOf(this.credits, this.creditsUpdatedAt), ...this.creditsError === undefined ? {} : { error: redactText(this.creditsError) } }
    return {
      id: this.variant.id,
      family: 'qoder',
      region: this.variant.region,
      label: this.variant.label,
      state,
      // A provider with no stored credential must not advertise one: the UI
      // would show a "saved" badge for a secret that does not exist.
      ...configured ? {
        credential: {
          source: device === undefined ? 'plugin' as const : 'app' as const,
          writable: device === undefined,
          ...credential.masked === undefined ? {} : { masked: credential.masked },
          ...credential.savedAtMs === undefined ? {} : { savedAt: credential.savedAtMs },
          ...credential.expiresAtMs === undefined ? {} : { expiresAt: credential.expiresAtMs },
          ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: credential.refreshExpiresAtMs },
        },
      } : {},
      ...device === undefined ? {} : { account: deviceAccountView(device) },
      ...credits === undefined ? {} : { credits },
      checkin: checkinViewOf(this.prefs, configured, now),
      catalog: {
        source: this.catalogSource === 'fallback' ? BUILTIN_SOURCE : this.catalogSource,
        ...this.catalogFetchedAtMs === undefined ? {} : { updatedAt: this.catalogFetchedAtMs },
        ...this.catalogError === undefined ? {} : { error: redactText(this.catalogError) },
        models,
      },
      warnings,
      capabilities: {
        usage: configured,
        checkin: configured,
        transfer: false,
        probes: false,
        multiAccount: false,
      },
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.refreshCatalog(), this.refreshUsage()])
  }

  async action(action: HubAction): Promise<ProviderActionResult> {
    switch (action.type) {
      case 'save-secret':
        return this.saveSecret(action.secret)
      case 'clear-secret':
        return this.clearSecret()
      case 'import-desktop-login':
        return this.importDesktopLoginAction()
      case 'refresh-catalog':
        return this.refreshCatalogAction()
      case 'refresh-usage':
        return this.refreshUsageAction()
      case 'checkin':
        return this.checkinAction()
      case 'set-checkin':
        return this.setCheckin(action)
      case 'clear-checkin-log':
        return this.clearCheckinLog()
      case 'set-model-enabled':
        return this.setModelsEnabled([action.modelId], action.enabled)
      case 'set-models-enabled':
        return this.setModelsEnabled(action.modelIds, action.enabled)
      case 'set-max-context':
        return this.setMaxContext(action.useMax)
      default:
        return {}
    }
  }

  /** Fire-and-forget refresh/check-in work: failures surface in status, never crash. */
  private runInBackground(kind: 'catalog' | 'usage' | 'checkin' | 'desktop', work: () => Promise<void>): void {
    runBackgroundTask({
      label: this.variant.displayName,
      log: this.log,
      work,
      onError: (error: unknown) => {
        if (this.disposed) return
        if (isCredentialFailure(error)) this.authFailure = true
        if (kind === 'catalog') this.catalogError = stripInternalErrorMarkers(redactText(errorText(error))).slice(0, 300)
        else if (kind === 'usage') this.creditsError = stripInternalErrorMarkers(redactText(errorText(error))).slice(0, 300)
        else if (kind === 'desktop') {
          this.desktopLoginError = {
            code: 'credential-unusable',
            message: `读取 Qoder 桌面端登录失败：${redactText(errorText(error)).slice(0, 200)}`,
          }
        }
        // A check-in failure already has a user-visible record/log row; an
        // unexpected one is only worth the log line.
        this.deps.notifyChanged()
      },
    })
  }

  private applyPrefs(): void {
    this.catalog.setUseMaximumContextWindow(this.prefs.useMaxContext)
    this.catalog.setDisabledModels(this.prefs.disabledModels)
  }

  /** Reveal/seed the catalog for whoever currently holds the credential. */
  private adoptIdentity(): void {
    const identity = this.store.identity()
    const changed = this.identityGuard.update(identity)
    if (changed) {
      // Credits belong to the PAT that fetched them. Drop them and abandon the
      // previous identity's in-flight reads instead of joining or showing them.
      this.credits = undefined
      this.creditsUpdatedAt = 0
      this.creditsError = undefined
      this.catalogFlight = undefined
      this.usageFlight = undefined
    }
    this.identity = identity
    this.authFailure = false
    if (identity === undefined) {
      this.catalog.setVisible(false)
      this.catalog.set(FALLBACK_QODER_MODELS)
      this.catalogSource = 'fallback'
      this.catalogFetchedAtMs = undefined
      this.catalogError = undefined
      this.credits = undefined
      this.creditsError = undefined
      this.invalidate()
      return
    }
    const saved = this.savedCatalogs.get(identity)
    if (saved !== undefined) {
      this.catalog.set(saved.models)
      this.catalogSource = 'saved'
      this.catalogFetchedAtMs = saved.fetchedAtMs
    } else {
      this.catalog.set(FALLBACK_QODER_MODELS)
      this.catalogSource = 'fallback'
      this.catalogFetchedAtMs = undefined
    }
    this.catalogError = undefined
    this.catalog.setVisible(true)
    this.invalidate()
  }

  /** Notify the model directory that this route's answers changed. */
  private invalidate(): void {
    if (this.releaseAdapter === undefined) return
    this.adapter?.invalidate()
    this.deps.ctx.emit('llm/adapters-updated')
  }

  private async startProvider(): Promise<void> {
    try {
      const shim = createQoderShim({
        store: this.store,
        client: this.client,
        catalog: this.catalog,
        providerId: this.variant.id,
        logger: shimLoggerFor(this.log),
      })
      await shim.ready
      this.shim = shim
      const adapter = createQoderAdapter({
        providerId: this.variant.id,
        displayName: this.variant.displayName,
        shim,
        catalog: this.catalog,
        resolveAttachments: () => this.resolveAttachments(),
      })
      this.adapter = adapter
      this.releaseAdapter = this.deps.ctx.llm.registerAdapter([this.variant.id], adapter.adapter)
      try {
        this.releaseDirectory = this.deps.ctx.llm.registerConfigurableProviders([{
          provider: this.variant.id,
          displayName: this.variant.displayName,
          settingsNs: this.variant.id,
          settingsPath: [],
          declared: false,
        }])
      } catch (error) {
        this.releaseAdapter?.()
        this.releaseAdapter = undefined
        throw error
      }
      this.providerError = undefined
    } catch (error) {
      this.providerError = errorText(error)
      this.log.error(`${this.variant.displayName} 模型服务注册失败：${this.providerError}`)
      await this.closeShim()
    }
  }

  private async closeShim(): Promise<void> {
    const shim = this.shim
    this.shim = undefined
    if (shim === undefined) return
    try {
      await shim.close()
    } catch (error) {
      this.log.warn(`关闭本地回环端点失败：${errorText(error)}`)
    }
  }

  private startTimers(): void {
    this.deps.scheduler.every(`${this.timerPrefix}:credential-sweep`, CREDENTIAL_POLL_MS, () => this.syncCredentials())
    this.deps.scheduler.every(`${this.timerPrefix}:usage-poll`, USAGE_POLL_MS, async () => {
      if (this.store.current() !== undefined) await this.refreshUsage()
    })
  }

  /** Reconcile the cached credential with the vault; fetch on account changes. */
  private async syncCredentials(): Promise<void> {
    if (this.disposed) return
    const previous = this.identity
    const credential = await this.store.reload()
    if (credential === undefined) {
      if (previous !== undefined || this.catalog.isVisible()) {
        this.adoptIdentity()
        this.deps.notifyChanged()
      }
      if (this.prefs.autoLogin) this.runInBackground('desktop', () => this.autoImportDesktopLogin())
      return
    }
    const identity = this.store.identity()
    if (identity !== previous) {
      this.adoptIdentity()
      this.deps.notifyChanged()
      this.runInBackground('catalog', () => this.refreshCatalog())
      this.runInBackground('usage', () => this.refreshUsage())
      this.maybeCatchUp()
      return
    }
    if (credential.kind === 'device' && this.prefs.autoLogin) {
      this.runInBackground('desktop', () => this.mergeDesktopLogin())
    }
    if (this.catalogSource !== 'live' && Date.now() - this.lastCatalogFetchAtMs >= CATALOG_RETRY_MS) {
      this.runInBackground('catalog', () => this.refreshCatalog())
    }
  }

  private refreshCatalog(): Promise<void> {
    if (this.catalogFlight !== undefined) return this.catalogFlight
    let run: Promise<void>
    run = this.fetchCatalog().finally(() => {
      if (this.catalogFlight === run) this.catalogFlight = undefined
    })
    this.catalogFlight = run
    return run
  }

  private async fetchCatalog(): Promise<void> {
    let credential: QoderCredential | undefined
    try {
      credential = await this.store.load()
    } catch (error) {
      if (this.disposed) return
      this.catalogError = redactText(errorText(error)).slice(0, 300)
      if (isCredentialFailure(error)) this.authFailure = true
      this.log.warn(`${this.variant.displayName} 模型目录刷新失败：${errorText(error)}`)
      this.deps.notifyChanged()
      return
    }
    if (credential === undefined) {
      this.adoptIdentity()
      this.deps.notifyChanged()
      return
    }
    const identity = this.store.identity()
    if (identity === undefined) {
      this.adoptIdentity()
      this.deps.notifyChanged()
      return
    }
    if (identity !== this.identity) this.adoptIdentity()
    const stamp = this.identityGuard.capture()
    this.lastCatalogFetchAtMs = Date.now()
    try {
      const models = await this.client.fetchModels()
      if (this.disposed || !this.identityGuard.isCurrent(stamp)) return
      if (identity !== this.store.identity()) {
        // The vault changed out-of-band while the directory read was in
        // flight (no adoptIdentity call). Discard the answer but adopt the new
        // identity like the failure path does, so the guard moves and the
        // action reports stale_identity instead of success with the old count.
        this.adoptIdentity()
        this.deps.notifyChanged()
        return
      }
      this.catalog.set(models)
      this.catalogSource = 'live'
      this.catalogFetchedAtMs = Date.now()
      this.catalogError = undefined
      this.authFailure = false
      this.savedCatalogs.set(identity, { fetchedAtMs: this.catalogFetchedAtMs, models })
      this.invalidate()
      this.log.info(`${this.variant.displayName} 模型目录已更新（${models.length} 个模型）`)
    } catch (error) {
      if (this.disposed || !this.identityGuard.isCurrent(stamp)) return
      if (this.store.identity() !== identity) {
        this.adoptIdentity()
        this.deps.notifyChanged()
        return
      }
      this.catalogError = redactText(errorText(error)).slice(0, 300)
      if (isCredentialFailure(error)) this.authFailure = true
      this.log.warn(`${this.variant.displayName} 模型目录刷新失败：${errorText(error)}`)
    }
    this.deps.notifyChanged()
  }

  private refreshUsage(): Promise<void> {
    if (this.usageFlight !== undefined) return this.usageFlight
    let run: Promise<void>
    run = this.fetchUsage().finally(() => {
      if (this.usageFlight === run) this.usageFlight = undefined
    })
    this.usageFlight = run
    return run
  }

  private async fetchUsage(): Promise<void> {
    let credential: QoderCredential | undefined
    try {
      credential = await this.store.load()
    } catch (error) {
      if (this.disposed) return
      this.creditsError = redactText(errorText(error)).slice(0, 300)
      if (isCredentialFailure(error)) this.authFailure = true
      this.log.warn(`${this.variant.displayName} 额度刷新失败：${errorText(error)}`)
      this.deps.notifyChanged()
      return
    }
    // A PAT changed in the vault without an explicit save: adopt it first so
    // this read is stamped with, and can only publish for, the new identity.
    if (this.store.identity() !== this.identity) this.adoptIdentity()
    const stamp = this.identityGuard.capture()
    if (credential === undefined || stamp.identity === undefined) return
    try {
      const credits = await this.client.fetchCredits()
      if (this.disposed || !this.identityGuard.isCurrent(stamp)) return
      if (this.store.identity() !== stamp.identity) {
        this.adoptIdentity()
        this.deps.notifyChanged()
        return
      }
      this.credits = credits
      this.creditsUpdatedAt = Date.now()
      this.creditsError = undefined
      this.authFailure = false
    } catch (error) {
      if (this.disposed || !this.identityGuard.isCurrent(stamp)) return
      if (this.store.identity() !== stamp.identity) {
        this.adoptIdentity()
        this.deps.notifyChanged()
        return
      }
      this.creditsError = redactText(errorText(error)).slice(0, 300)
      if (isCredentialFailure(error)) this.authFailure = true
      this.log.warn(`${this.variant.displayName} 额度刷新失败：${errorText(error)}`)
    }
    this.deps.notifyChanged()
  }

  private armCheckin(): void {
    const name = `${this.timerPrefix}:checkin`
    this.deps.scheduler.clear(name)
    if (!this.prefs.checkin.enabled) return
    this.deps.scheduler.atUtc8Minute(name, this.prefs.checkin.minute, async () => {
      await this.runScheduledCheckin()
    })
  }

  /** Claim today's benefit if the configured moment passed while signed out. */
  private maybeCatchUp(): void {
    if (!shouldCatchUp(this.prefs.checkin)) return
    if (this.store.current() === undefined) return
    this.runInBackground('checkin', () => this.runScheduledCheckin())
  }

  private async runScheduledCheckin(): Promise<void> {
    if (this.disposed || !this.prefs.checkin.enabled) return
    if (this.store.current() === undefined) return
    if (settledToday(this.prefs.checkin)) return
    const result = await this.performCheckin()
    if (result !== undefined) {
      this.log.info(`${this.variant.displayName} 自动签到：${checkinMessage(result)}`)
    }
  }

  private async performCheckin(): Promise<QoderCheckInResult | undefined> {
    try {
      const result = await this.transport.checkIn()
      this.prefs = applyCheckinResult(this.prefs, result)
      await writePrefs(this.deps.prefs, this.variant.id, this.prefs)
      if (result.status === 'claimed') this.runInBackground('usage', () => this.refreshUsage())
      this.deps.notifyChanged()
      return result
    } catch (error) {
      this.log.warn(`${this.variant.displayName} 签到失败：${errorText(error)}`)
      return undefined
    }
  }

  /** Probe the desktop app's saved sign-in once; returns a value, never throws. */
  private async probeDesktopLogin(): Promise<QoderDesktopReadResult> {
    const result = await this.readDesktopAuth(this.variant)
    this.lastDesktopProbeAt = Date.now()
    return result
  }

  /**
   * Confirm an imported token works against this route's region and fill in
   * the account fields the desktop record may omit.
   */
  private async validateDesktopLogin(
    imported: QoderDesktopCredential,
  ): Promise<{ ok: true; credential: QoderDesktopCredential } | { ok: false; message: string }> {
    try {
      const identity = await fetchQoderUserInfo({
        region: this.variant.upstreamRegion,
        token: imported.token,
        signal: AbortSignal.timeout(DESKTOP_VALIDATE_TIMEOUT_MS),
      })
      const name = imported.user.name ?? (identity.name === '' ? undefined : identity.name)
      const email = imported.user.email ?? (identity.email === '' ? undefined : identity.email)
      return {
        ok: true,
        credential: {
          ...imported,
          user: {
            id: identity.userID,
            ...name === undefined ? {} : { name },
            ...email === undefined ? {} : { email },
          },
        },
      }
    } catch (error: unknown) {
      return {
        ok: false,
        message: `读取到的 Qoder 桌面端登录无法通过该区域校验：${redactText(errorText(error))}`,
      }
    }
  }

  /** Persist an adopted desktop sign-in and refresh everything keyed to it. */
  private async adoptDesktopLogin(imported: QoderDesktopCredential): Promise<QoderDeviceCredential> {
    const saved = await this.store.saveDevice(imported)
    this.desktopLoginError = undefined
    this.adoptIdentity()
    this.deps.notifyChanged()
    this.runInBackground('catalog', () => this.refreshCatalog())
    this.runInBackground('usage', () => this.refreshUsage())
    this.maybeCatchUp()
    return saved
  }

  /**
   * Background first-run import. Silent by design: while nothing is configured
   * a probe runs at most once per retry window, and every failure becomes a
   * localized status warning rather than a user-facing error.
   */
  private async autoImportDesktopLogin(): Promise<void> {
    if (this.disposed || this.desktopProbeInFlight || !this.prefs.autoLogin) return
    if (this.store.current() !== undefined) return
    if (Date.now() - this.lastDesktopProbeAt < DESKTOP_DETECT_RETRY_MS) return
    this.desktopProbeInFlight = true
    try {
      const result = await this.probeDesktopLogin()
      if (this.disposed) return
      if (result.state !== 'found') {
        this.desktopLoginError = {
          code: desktopFailureWarningCode(result),
          message: desktopFailureMessage(result, this.variant.label.zh),
        }
        this.deps.notifyChanged()
        return
      }
      if (this.store.current() !== undefined) return
      await this.adoptDesktopLogin(result.credential)
      if (this.disposed) return
      this.log.info(`${this.variant.displayName} 已自动读取 Qoder 桌面端登录`)
    } finally {
      this.desktopProbeInFlight = false
    }
  }

  /**
   * Background sweep: follow a desktop re-sign-in (same account rotated by the
   * app, or another account signed in there). A record that is not newer than
   * the hub's own rotated pair is ignored, so the hub never downgrades itself.
   */
  private async mergeDesktopLogin(): Promise<void> {
    if (this.disposed || !this.prefs.autoLogin) return
    const current = this.store.current()
    if (current === undefined || current.kind !== 'device') return
    if (Date.now() - this.lastDesktopProbeAt < DESKTOP_MERGE_INTERVAL_MS) return
    const result = await this.probeDesktopLogin()
    if (this.disposed || result.state !== 'found') return
    const candidate = result.credential
    const sameAccount = candidate.user.id !== '' && candidate.user.id === current.user.id
    const newer = candidate.expiresAtMs > current.expiresAtMs + 60_000
    if (candidate.token === current.token || (sameAccount && !newer) || (!sameAccount && candidate.user.id === '')) {
      return
    }
    const validated = await this.validateDesktopLogin(candidate)
    if (this.disposed || !validated.ok) return
    const changed = await this.store.mergeDesktop(validated.credential)
    if (!changed) return
    this.log.info(`${this.variant.displayName} 已更新 Qoder 桌面端登录`)
    this.adoptIdentity()
    this.deps.notifyChanged()
    this.runInBackground('catalog', () => this.refreshCatalog())
    this.runInBackground('usage', () => this.refreshUsage())
    this.maybeCatchUp()
  }

  /** Explicit user request: read the desktop sign-in now, or explain why not. */
  private async importDesktopLoginAction(): Promise<ProviderActionResult> {
    const result = await this.probeDesktopLogin()
    if (result.state !== 'found') {
      const message = desktopFailureMessage(result, this.variant.label.zh)
      this.desktopLoginError = { code: desktopFailureWarningCode(result), message }
      this.deps.notifyChanged()
      throw new ProviderActionError(desktopFailureActionCode(result), message)
    }
    const validated = await this.validateDesktopLogin(result.credential)
    if (!validated.ok) {
      this.desktopLoginError = { code: 'credential-unusable', message: validated.message }
      this.deps.notifyChanged()
      throw new ProviderActionError('desktop_login_rejected', validated.message)
    }
    const current = this.store.current()
    const currentDevice = current !== undefined && current.kind === 'device' ? current : undefined
    const candidate = validated.credential
    // An unknown identity on either side cannot prove freshness by account, so
    // only a strictly newer token may replace it.
    const comparableIdentity = currentDevice !== undefined
      && (currentDevice.user.id === '' || candidate.user.id === ''
        || currentDevice.user.id === candidate.user.id)
    const candidateIsNewer = candidate.expiresAtMs > 0
      && currentDevice !== undefined
      && candidate.expiresAtMs > currentDevice.expiresAtMs + 60_000
    const currentExpiryUnknown = currentDevice !== undefined && currentDevice.expiresAtMs <= 0
    if (currentDevice !== undefined
      && comparableIdentity && !candidateIsNewer && !currentExpiryUnknown) {
      // The hub already holds a pair at least as fresh as the desktop file
      // (typically one it rotated itself). Re-reading must not downgrade it.
      this.desktopLoginError = undefined
      this.prefs = { ...this.prefs, autoLogin: true }
      await writePrefs(this.deps.prefs, this.variant.id, this.prefs)
      this.deps.notifyChanged()
      return { message: 'Qoder 桌面端登录已是最新，无需重新读取', code: 'login-latest' }
    }
    const saved = await this.adoptDesktopLogin(validated.credential)
    this.prefs = { ...this.prefs, autoLogin: true }
    await writePrefs(this.deps.prefs, this.variant.id, this.prefs)
    this.log.info(`${this.variant.displayName} 已从 Qoder 桌面端读取登录`)
    return { message: `已读取登录状态：${deviceAccountView(saved).label}`, code: 'login-imported', params: { account: deviceAccountView(saved).label } }
  }

  private async saveSecret(secret: string): Promise<ProviderActionResult> {
    const pat = secret.trim()
    if (pat === '') throw new ProviderActionError('invalid_secret', 'PAT 不能为空')
    const valid = await validateApiKey(pat, this.variant.upstreamRegion)
    if (!valid) {
      throw new ProviderActionError(
        'secret_rejected',
        `${this.variant.label.zh} PAT 校验失败：令牌被该区域拒绝，或网络暂不可达；请确认令牌属于该区域后重试（未保存）`,
      )
    }
    await this.store.savePat(pat)
    // An explicit PAT is a deliberate choice: stop importing the desktop
    // sign-in until the user asks for it again.
    this.prefs = { ...this.prefs, autoLogin: false }
    await writePrefs(this.deps.prefs, this.variant.id, this.prefs)
    this.desktopLoginError = undefined
    this.adoptIdentity()
    this.deps.notifyChanged()
    this.runInBackground('catalog', () => this.refreshCatalog())
    this.runInBackground('usage', () => this.refreshUsage())
    this.maybeCatchUp()
    return {
      message: `${this.variant.label.zh} PAT 已保存`,
      code: 'pat-saved',
      data: { masked: this.store.summary().masked },
    }
  }

  private async clearSecret(): Promise<ProviderActionResult> {
    const wasDevice = this.store.current()?.kind === 'device'
    await this.store.clear()
    this.prefs = { ...this.prefs, autoLogin: false }
    await writePrefs(this.deps.prefs, this.variant.id, this.prefs)
    this.desktopLoginError = undefined
    this.adoptIdentity()
    this.deps.notifyChanged()
    return {
      message: wasDevice
        ? '已清除插件保存的凭证；Qoder 桌面端的登录状态不受影响'
        : `${this.variant.label.zh} 凭证已清除`,
      code: 'credential-cleared',
    }
  }

  private async refreshCatalogAction(): Promise<ProviderActionResult> {
    if (this.store.current() === undefined) throw new ProviderActionError('not_configured', '尚未登录 Qoder；请先在 Qoder 桌面端登录一次，或重新读取登录')
    const before = this.identityGuard.capture()
    await this.refreshCatalog()
    if (!this.identityGuard.isCurrent(before)) {
      throw new ProviderActionError('stale_identity', '账号已切换，已丢弃旧账号的模型目录结果')
    }
    if (this.catalogError !== undefined) {
      throw new ProviderActionError('catalog_refresh_failed', `模型目录刷新失败：${redactText(this.catalogError)}`)
    }
    const count = this.catalog.all().length
    return { message: `模型目录已刷新（${count} 个模型）`, code: 'catalog-refreshed', params: { count } }
  }

  private async refreshUsageAction(): Promise<ProviderActionResult> {
    if (this.store.current() === undefined) throw new ProviderActionError('not_configured', '尚未登录 Qoder；请先在 Qoder 桌面端登录一次，或重新读取登录')
    const before = this.identityGuard.capture()
    await this.refreshUsage()
    if (!this.identityGuard.isCurrent(before)) {
      throw new ProviderActionError('stale_identity', '账号已切换，已丢弃旧账号的额度结果')
    }
    if (this.creditsError !== undefined) {
      throw new ProviderActionError('usage_refresh_failed', `额度刷新失败：${redactText(this.creditsError)}`)
    }
    return { message: '额度已刷新', code: 'usage-refreshed' }
  }

  private async checkinAction(): Promise<ProviderActionResult> {
    if (this.store.current() === undefined) throw new ProviderActionError('not_configured', '尚未登录 Qoder；请先在 Qoder 桌面端登录一次，或重新读取登录')
    const result = await this.performCheckin()
    if (result === undefined) throw new ProviderActionError('checkin_failed', '签到失败，请稍后重试')
    return {
      message: checkinMessage(result),
      ...checkinMessageCode(result),
      data: { status: result.status, ...result.amount === undefined ? {} : { amount: result.amount } },
    }
  }

  private async setCheckin(action: Extract<HubAction, { type: 'set-checkin' }>): Promise<ProviderActionResult> {
    const enabled = action.enabled === undefined ? this.prefs.checkin.enabled : action.enabled
    const minute = action.minute === undefined
      ? this.prefs.checkin.minute
      : normalizeCheckInMinute(action.minute)
    this.prefs = { ...this.prefs, checkin: { ...this.prefs.checkin, enabled, minute } }
    await writePrefs(this.deps.prefs, this.variant.id, this.prefs)
    this.armCheckin()
    if (enabled) this.maybeCatchUp()
    this.deps.notifyChanged()
    if (action.enabled === undefined && action.minute !== undefined) {
      return { message: `签到时间已设为 ${formatMinute(minute)}（UTC+8）`, code: 'checkin-time-set', params: { time: formatMinute(minute) } }
    }
    return {
      message: enabled
        ? `自动签到已开启，每天 ${formatMinute(minute)}（UTC+8）`
        : '自动签到已关闭',
      code: enabled ? 'checkin-schedule-on' : 'checkin-schedule-off',
      ...enabled ? { params: { time: formatMinute(minute) } } : {},
    }
  }

  private async clearCheckinLog(): Promise<ProviderActionResult> {
    this.prefs = { ...this.prefs, checkin: { ...this.prefs.checkin, logs: [] } }
    await writePrefs(this.deps.prefs, this.variant.id, this.prefs)
    this.deps.notifyChanged()
    return { message: '签到记录已清空', code: 'checkin-log-cleared' }
  }

  private async setModelsEnabled(modelIds: readonly string[], enabled: boolean): Promise<ProviderActionResult> {
    const before = new Set(this.prefs.disabledModels)
    const disabled = new Set(before)
    for (const id of modelIds) {
      if (enabled) disabled.delete(id)
      else disabled.add(id)
    }
    let changed = 0
    for (const id of new Set(modelIds)) {
      if (before.has(id) !== disabled.has(id)) changed += 1
    }
    if (changed === 0) return {}
    this.prefs = { ...this.prefs, disabledModels: [...disabled] }
    await writePrefs(this.deps.prefs, this.variant.id, this.prefs)
    if (this.catalog.setDisabledModels(this.prefs.disabledModels)) this.invalidate()
    this.deps.notifyChanged()
    return {
      message: enabled ? `已启用 ${changed} 个模型` : `已停用 ${changed} 个模型`,
      code: enabled ? 'models-enabled' : 'models-disabled',
      params: { count: changed },
    }
  }

  private async setMaxContext(useMax: boolean): Promise<ProviderActionResult> {
    this.prefs = { ...this.prefs, useMaxContext: useMax }
    await writePrefs(this.deps.prefs, this.variant.id, this.prefs)
    if (this.catalog.setUseMaximumContextWindow(useMax)) this.invalidate()
    this.deps.notifyChanged()
    return {
      message: useMax ? '已切换为最大上下文窗口' : '已切换为默认上下文窗口',
      code: useMax ? 'max-context-on' : 'max-context-off',
    }
  }
}

export function createQoderRuntime(
  deps: ProviderDeps,
  variant: QoderVariant,
  overrides: QoderRuntimeOverrides = {},
): ProviderRuntime {
  return new QoderProviderRuntime(deps, variant, overrides)
}

