/**
 * One WorkBuddy provider route: credential discovery, catalog lifecycle,
 * usage cache, probe state, and the pi-ai adapter behind a loopback shim.
 *
 * Everything the hub calls is synchronous where the contract says so: `status()`
 * builds its document from cached state only, and network reads happen on
 * `init()`, the background sign-in and usage polls, `refresh-catalog`,
 * `refresh-usage`, or the explicit refresh action.
 */

import type {} from '@deepseek-ai/dsh-llm'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CheckinLogRow, HubAction, ProbeView } from '../../shared/contracts.ts'
import {
  checkinViewOf,
  defaultWorkBuddyCheckinPrefs,
  formatCheckinMinute,
  normalizeCheckinMinute,
  parseWorkBuddyCheckinPrefs,
  shouldCatchUp,
  utc8DateOf,
  withCheckinLog,
  type WorkBuddyCheckinPrefs,
} from './checkin.ts'
import type { ProviderActionResult, ProviderDeps, ProviderDescriptor, ProviderRuntime } from '../../core/types.ts'
import { ProviderActionError } from '../../core/types.ts'
import { SingleFlight } from '../../core/scheduler.ts'
import { redactHome, redactText } from '../../core/redact.ts'
import { createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
import {
  WorkBuddyCredentialStore,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
  type WorkBuddyCredentialSource,
} from './auth.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './catalog.ts'
import { WorkBuddyCatalogStore } from './catalog-store.ts'
import { resolveAppVersion, VersionCache } from './app-version.ts'
import { createChatIdentityResolver } from './client-identity.ts'
import { toCreditsView, creditsErrorView } from './credits.ts'
import { accountDetailOf, accountKeyOf, maskAccountLabel, maskToken, visibilityAccountOf } from './mask.ts'
import { toHubModel } from './models.ts'
import { PROBE_REQUEST_TIMEOUT_MS } from './probe.ts'
import { WorkBuddyProbeService } from './probe-service.ts'
import { WorkBuddyProbeStore, type WorkBuddyProbeRecord } from './probe-store.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
import {
  buildProviderStatus,
  buildWarnings,
  probeStateOf,
  type WorkBuddyCatalogSource,
  type WorkBuddyCredentialView,
  type WorkBuddyStatusInput,
} from './status.ts'
import {
  WorkBuddyUpstreamClient,
  type WorkBuddyCheckinActivity,
  type WorkBuddyCredits,
  type WorkBuddyUpstream,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
import type { WorkBuddyVariant } from './variants.ts'
import { WorkBuddyVisibilityStore } from './visibility-store.ts'

/** How often the desktop sign-in is re-checked (milliseconds). */
const CREDENTIAL_POLL_MS = 30_000

/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 1_000
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** A failed catalog fetch is retried after this many polls, not every poll. */
const CATALOG_RETRY_SWEEPS = 10

/** How often the billed usage is re-read in the background (milliseconds). */
const USAGE_REFRESH_MS = 5 * 60_000

/** How often the check-in activity is reread on the slow usage timer. */
const CHECKIN_STATUS_REFRESH_MS = 10 * 60_000

/** The most a single model test may take before it is abandoned. */
const MODEL_TEST_TIMEOUT_MS = PROBE_REQUEST_TIMEOUT_MS

/** A masked account snapshot, cached across restarts for diagnostics. */
interface AccountSnapshot {
  label?: string
  detail?: string
  enterprise?: boolean
  identity: string
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  savedAtMs: number
}

/** One catalog request plus the identity/generation it is allowed to publish. */
interface CatalogFetch {
  identity: string
  generation: number
  controller: AbortController
  /** False when the answer was discarded because the identity moved on. */
  promise: Promise<boolean>
}

/** Test seams; the production factory passes none of them. */
export interface WorkBuddyRuntimeOptions {
  client?: WorkBuddyUpstream
  credentialStore?: WorkBuddyCredentialSource
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /** Skip the loopback shim and adapter registration (offline tests). */
  skipTransport?: boolean
  /** Overrides the sign-in poll interval. */
  pollMs?: number
  /** Overrides the periodic usage refresh interval. */
  usagePollMs?: number
  /** Clock injection for deterministic tests. */
  now?: () => number
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the poll interval, honoring the override when it is usable. */
function credentialPollMs(): number {
  const override = Number(process.env['DSH_WORKBUDDY_POLL_MS'])
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/** Whether a model can be probed by hand: it reasons and declares no effort set. */
function isProbeCandidate(info: { reasoning?: { supports: boolean, supportedEfforts?: readonly string[] } }): boolean {
  if (info.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/** The pi-ai adapter bundle held while the transport is running. */
interface Transport {
  shim: WorkBuddyShim
  adapter: WorkBuddyAdapter
  release: () => void
}

/** One WorkBuddy route. */
export class WorkBuddyRuntime implements ProviderRuntime {
  readonly descriptor: ProviderDescriptor
  private readonly deps: ProviderDeps
  private readonly variant: WorkBuddyVariant
  private readonly clock: () => number
  private readonly client: WorkBuddyUpstream
  private readonly credentials: WorkBuddyCredentialSource
  private readonly catalog: WorkBuddyCatalog
  private readonly savedCatalogs: WorkBuddyCatalogStore
  private readonly visibility: WorkBuddyVisibilityStore
  private readonly probes: WorkBuddyProbeStore
  private readonly probeService: WorkBuddyProbeService
  private readonly versionCache: VersionCache
  private readonly appVersion: () => Promise<import('./app-version.ts').AppVersionInfo>
  private readonly chatIdentity: ReturnType<typeof createChatIdentityResolver>
  private readonly keys: Record<string, string>
  private usageFlight = new SingleFlight<ProviderActionResult>()
  /**
   * Number of callers waiting on a usage read, including flights superseded by
   * an identity change. The background triggers use it to avoid starting a
   * second billed request while the first one is still running.
   */
  private usageReads = 0
  private readonly modelTestFlight = new SingleFlight<
    { modelId: string, verdict: string, detail?: string }[]
  >()
  private readonly skipTransport: boolean
  private transport: Transport | undefined
  private started = false
  private disposed = false
  private authStatus: WorkBuddyAuthStatus = { state: 'signed-out', reasonCode: 'no-credential' }
  private accountSnapshot: AccountSnapshot | undefined
  private lastCredential: WorkBuddyCredential | undefined
  private credentialError: string | undefined
  private transportError: string | undefined
  private catalogSource: WorkBuddyCatalogSource = 'builtin'
  private catalogFetchedAtMs: number | undefined
  private catalogError: string | undefined
  private lastFetchAtMs = 0
  private catalogGeneration = 0
  private lastIdentity: string | undefined
  private visibilityAccount: string | undefined
  private inflightCatalog: CatalogFetch | undefined
  private creditsRaw: WorkBuddyCredits | undefined
  private creditsUpdatedAt: number | undefined
  private creditsError: string | undefined
  private probeConsent = false
  private useMaxContext = false
  private checkinPrefs: WorkBuddyCheckinPrefs = defaultWorkBuddyCheckinPrefs()
  private checkinActivity: WorkBuddyCheckinActivity | undefined
  private checkinFetchedAt = 0
  private checkinCatchUpAttempted = false
  private readonly checkinFlight = new SingleFlight<ProviderActionResult>()
  private probingModelId: string | undefined
  private pollMs = credentialPollMs()
  private usagePollMs = USAGE_REFRESH_MS

  constructor(deps: ProviderDeps, variant: WorkBuddyVariant, options: WorkBuddyRuntimeOptions = {}) {
    this.deps = deps
    this.variant = variant
    this.clock = options.now ?? (() => Date.now())
    this.skipTransport = options.skipTransport === true
    if (options.pollMs !== undefined) this.pollMs = options.pollMs
    if (options.usagePollMs !== undefined) this.usagePollMs = options.usagePollMs
    const prefix = `provider:${variant.id}:`
    this.keys = {
      catalog: `${prefix}catalog`,
      visibility: `${prefix}visibility`,
      probes: `${prefix}probes`,
      consent: `${prefix}probe-consent`,
      maxContext: `${prefix}max-context`,
      account: `${prefix}account`,
      version: `${prefix}version`,
      checkin: `${prefix}checkin`,
    }
    this.descriptor = {
      id: variant.id,
      family: 'workbuddy',
      region: variant.region,
      label: { zh: variant.displayName, en: variant.displayName },
    }

    this.versionCache = new VersionCache(deps.prefs, this.keys['version']!)
    this.appVersion = () => resolveAppVersion({ cache: this.versionCache })
    this.chatIdentity = createChatIdentityResolver({
      ...(variant.region === 'global'
        ? { cacheIntl: this.versionCache, resolveIntl: this.appVersion }
        : { cacheCn: this.versionCache }),
    })
    this.client =
      options.client ??
      new WorkBuddyUpstreamClient({
        resolveAppVersion: this.appVersion,
        resolveChatIdentity: this.chatIdentity,
      })
    this.credentials =
      options.credentialStore ??
      new WorkBuddyCredentialStore({
        variant,
        vault: deps.vault,
        slot: variant.slot,
        ...(options.desktopPath === undefined ? {} : { desktopPath: options.desktopPath }),
        refresh: (credential) => this.client.refreshToken(credential),
      })
    this.catalog = new WorkBuddyCatalog(
      variant.region === 'global' ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS,
    )
    // A route with no account serves no models: an empty catalog is how the
    // picker hides a group without touching registration.
    this.catalog.setVisible(false)
    this.savedCatalogs = new WorkBuddyCatalogStore(deps.prefs, this.keys['catalog']!)
    this.visibility = new WorkBuddyVisibilityStore(deps.prefs, this.keys['visibility']!)
    this.probes = new WorkBuddyProbeStore({
      prefs: deps.prefs,
      key: this.keys['probes']!,
      pluginVersion: deps.version,
      now: this.clock,
    })
    this.probeService = new WorkBuddyProbeService({
      store: this.probes,
      catalog: this.catalog,
      credentials: this.credentials,
      client: this.client,
      consent: () => this.probeConsent,
      account: () => this.visibilityAccount,
      region: variant.region,
    })
  }

  async init(): Promise<void> {
    if (this.started) return
    this.started = true
    await Promise.all([
      this.visibility.load(),
      this.savedCatalogs.load(),
      this.probes.load(),
      this.versionCache.load(),
    ])
    this.probeConsent = (await this.deps.prefs.get<boolean>(this.keys['consent']!)) === true
    this.checkinPrefs = parseWorkBuddyCheckinPrefs(await this.deps.prefs.get<unknown>(this.keys['checkin']!))
    if (this.variant.region === 'global') {
      this.useMaxContext = (await this.deps.prefs.get<boolean>(this.keys['maxContext']!)) !== false
      this.catalog.setUseMaximumContextWindow(this.useMaxContext)
    }
    const storedAccount = await this.deps.prefs.get<AccountSnapshot>(this.keys['account']!)
    if (storedAccount !== undefined) this.accountSnapshot = storedAccount

    if (this.variant.region === 'global') this.ensureAppVersion()
    await this.syncAccount()
    await this.startTransport()
    // The first catalog and usage reads are not allowed to hold up startup: the
    // route is already serving its saved (or built-in) roster, and both reads
    // announce themselves through notifyChanged when they land. Reading the
    // quota here is what makes the credits card populated on the first visit;
    // without it the answer only appeared after an explicit refresh, unlike
    // every other provider.
    if (this.credentialsResolved()) {
      void this.fetchCatalog().catch(() => undefined)
      this.refreshUsageInBackground('初始读取')
      if (this.variant.region === 'cn') {
        this.armCheckin()
        this.refreshCheckinInBackground('初始读取')
      }
    } else {
      this.armCheckin()
    }
    this.schedulePolling()
    this.scheduleUsagePolling()
    this.deps.notifyChanged()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.deps.scheduler.clear(this.pollName())
    this.deps.scheduler.clear(this.usagePollName())
    this.deps.scheduler.clear(this.checkinName())
    this.inflightCatalog?.controller.abort()
    this.releaseTransport()
    await this.inflightCatalog?.promise.catch(() => undefined)
  }

  status() {
    const info = this.catalog.current()
    const hidden = new Set(this.visibilityAccount === undefined ? [] : this.visibility.disabled(this.visibilityAccount))
    // One record pass for both the model rows and the probe table: calling
    // recordFor() per model re-scanned the catalog for every row (O(N²)).
    const records = this.probeService.recordsFor(info)
    const models = info.map((entry) => {
      const observed = records.get(entry.id)
      return toHubModel(entry, {
        visible: !hidden.has(entry.id),
        useMaxContext: this.useMaxContext,
        ...(observed === undefined ? {} : { observed }),
        region: this.variant.region,
      })
    })
    const probeRows = this.probeRows(info, records)
    const rateUnknownCount = info.filter((entry) => entry.billing?.rateUnknown === true).length
    const warnings = buildWarnings({
      appName: this.variant.appName,
      auth: this.authStatus,
      credentialError: this.credentialError,
      transportError: this.transportError,
      catalogSource: this.catalogSource,
      catalogError: this.catalogError,
      creditsError: this.creditsError,
      credits: this.creditsRaw,
      rateUnknownCount,
      now: this.clock(),
    })
    const credential = this.credentialView()
    const account = this.accountView()
    const credits =
      this.creditsRaw !== undefined && this.creditsUpdatedAt !== undefined
        ? toCreditsView(this.creditsRaw, this.creditsUpdatedAt)
        : this.creditsError !== undefined
          ? creditsErrorView(this.creditsError, this.creditsUpdatedAt ?? this.clock())
          : undefined
    const input: WorkBuddyStatusInput = {
      descriptor: this.descriptor,
      auth: this.authStatus,
      credential,
      account,
      credentialError: this.credentialError,
      transportError: this.transportError,
      catalog: {
        source: this.catalogSource,
        ...(this.catalogFetchedAtMs === undefined ? {} : { updatedAt: this.catalogFetchedAtMs }),
        ...(this.catalogError === undefined ? {} : { error: this.catalogError }),
        models,
      },
      credits,
      ...(this.variant.region === 'cn'
        ? { checkin: checkinViewOf(this.checkinPrefs, this.checkinActivity, this.credentialsResolved(), this.clock()) }
        : {}),
      probeConsent: this.probeConsent,
      probeRows,
      warnings,
    }
    return buildProviderStatus(input)
  }

  /** Global refresh: catalog plus the billed usage read. */
  async refreshAll(): Promise<void> {
    if (!this.started || this.disposed) return
    await this.syncAccount()
    if (!this.credentialsResolved()) return
    await this.fetchCatalog().catch(() => undefined)
    await this.refreshUsage().catch(() => undefined)
    if (this.variant.region === 'cn') this.refreshCheckinInBackground('全局刷新')
    this.deps.notifyChanged()
  }

  async action(action: HubAction): Promise<ProviderActionResult> {
    if (this.disposed) return {}
    switch (action.type) {
      case 'refresh-account':
        return await this.refreshAccount()
      case 'refresh-catalog':
        return await this.refreshCatalog()
      case 'refresh-usage':
        return await this.refreshUsage()
      case 'checkin':
        return await this.claimCheckin()
      case 'set-checkin':
        return await this.setCheckin(action)
      case 'clear-checkin-log':
        return await this.clearCheckinLog()
      case 'set-model-enabled':
        return await this.setModelsEnabled([action.modelId], action.enabled)
      case 'set-models-enabled':
        return await this.setModelsEnabled(action.modelIds, action.enabled)
      case 'set-max-context':
        return await this.setMaxContext(action.useMax)
      case 'set-probe-consent':
        return await this.setProbeConsent(action.consent)
      case 'probe-model':
        return await this.probeModel(action.modelId)
      case 'test-models':
        return await this.testModels(action.modelIds)
      default:
        return {}
    }
  }

  private pollName(): string {
    return `workbuddy:${this.variant.id}:poll`
  }

  private usagePollName(): string {
    return `workbuddy:${this.variant.id}:usage`
  }

  private schedulePolling(): void {
    this.deps.scheduler.every(this.pollName(), this.pollMs, () => this.syncSweep())
  }

  /**
   * Re-read the billed usage on the same cadence as the other providers, so a
   * quota consumed in the desktop app converges without a manual refresh.
   *
   * Billing is a metering read with a real upstream cost, which is why it runs
   * on its own slow timer: the 30-second sign-in sweep only asks for a quota it
   * has just cleared by adopting a new account, never as a heartbeat.
   */
  private scheduleUsagePolling(): void {
    this.deps.scheduler.every(this.usagePollName(), this.usagePollMs, () => {
      if (this.disposed || !this.credentialsResolved() || this.usageReads > 0) return
      this.refreshUsageInBackground('定时刷新')
      if (this.variant.region === 'cn'
        && this.clock() - this.checkinFetchedAt >= CHECKIN_STATUS_REFRESH_MS) {
        this.refreshCheckinInBackground('定时刷新')
      }
    })
  }

  /**
   * Read the quota without letting the outcome escape.
   *
   * The answer lands in the status document, and a failure is published as
   * `creditsError` so the card can explain it; a background read has no caller
   * to reject, so the log records the reason. A read superseded by an account
   * switch is a normal outcome, not a failure — the new account's own read
   * follows it — so it is not logged.
   */
  private refreshUsageInBackground(reason: string): void {
    void this.refreshUsage().catch((error: unknown) => {
      if (this.disposed) return
      if (error instanceof ProviderActionError && error.code === 'stale_identity') return
      this.deps.log.warn(`${this.variant.id} 额度读取失败（${reason}）：${this.redact(errorText(error))}`)
    })
  }

  /** One poll: reconcile the sign-in and retry a stale catalog on a slow backoff. */
  private async syncSweep(): Promise<void> {
    if (this.disposed || !this.started) return
    await this.syncAccount()
    if (!this.credentialsResolved()) return
    // A sign-in or account switch clears the quota with the identity it belonged
    // to; read the new account's now instead of leaving the card empty until the
    // next slow timer. A loaded (or failed) answer already has an owner, so the
    // sweep never re-reads over it, and an in-flight read is never doubled.
    if (this.usageReads === 0 && this.creditsRaw === undefined && this.creditsError === undefined) {
      this.refreshUsageInBackground('登录状态变化')
    }
    const stale = this.catalogSource !== 'live'
    const due = this.clock() - this.lastFetchAtMs >= this.pollMs * CATALOG_RETRY_SWEEPS
    if (stale && due) await this.fetchCatalog().catch(() => undefined)
  }

  private credentialsResolved(): boolean {
    return this.authStatus.state === 'signed-in'
  }

  /** Re-read the desktop sign-in and reconcile the route with it. */
  private async syncAccount(): Promise<void> {
    try {
      const credential = await this.credentials.current()
      if (credential === undefined) {
        this.authStatus = { state: 'signed-out', reasonCode: 'no-credential' }
        this.lastCredential = undefined
        await this.adoptIdentity(undefined, undefined)
        return
      }
      this.credentialError = undefined
      this.authStatus = {
        state: 'signed-in',
        ...(credential.expiresAtMs > 0 ? { expiresAtMs: credential.expiresAtMs } : {}),
        ...(credential.refreshExpiresAtMs === undefined
          ? {}
          : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
        ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
        ...(credential.domain === '' ? {} : { domain: credential.domain }),
        source: credential.source,
      }
      this.lastCredential = credential
      await this.rememberAccount(credential)
      await this.adoptIdentity(accountKeyOf(credential), visibilityAccountOf(credential))
      // A previous credential failure hid the group; a working credential must
      // bring it back even when the account identity did not change.
      if (!this.catalog.isVisible()) {
        this.catalog.setVisible(true)
        this.invalidateAdapter()
      }
    } catch (error: unknown) {
      this.authStatus = {
        state: 'signed-out',
        reason: this.redact(errorText(error)).slice(0, 400),
      }
      this.lastCredential = undefined
      await this.adoptIdentity(undefined, undefined)
    }
  }

  /**
   * Adopt a credential that `resolve()` just refreshed: the status document
   * must report the token expiry and source actually in effect, not the stale
   * desktop snapshot a poll happened to see.
   */
  private rememberResolvedCredential(credential: WorkBuddyCredential): void {
    this.lastCredential = credential
    if (this.authStatus.state !== 'signed-in') return
    this.authStatus = {
      ...this.authStatus,
      source: credential.source,
      ...(credential.expiresAtMs > 0 ? { expiresAtMs: credential.expiresAtMs } : {}),
      ...(credential.refreshExpiresAtMs === undefined
        ? {}
        : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
    }
  }

  private async rememberAccount(credential: WorkBuddyCredential): Promise<void> {
    const label = maskAccountLabel(credential.nickname)
    const detail = accountDetailOf(credential)
    const snapshot: AccountSnapshot = {
      identity: accountKeyOf(credential),
      ...(label === undefined ? {} : { label }),
      ...(detail === undefined ? {} : { detail }),
      enterprise: credential.enterpriseId !== undefined && credential.enterpriseId !== '',
      ...(credential.expiresAtMs > 0 ? { expiresAtMs: credential.expiresAtMs } : {}),
      ...(credential.refreshExpiresAtMs === undefined
        ? {}
        : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
      savedAtMs: this.clock(),
    }
    this.accountSnapshot = snapshot
    try {
      await this.deps.prefs.set(this.keys['account']!, snapshot)
    } catch (error: unknown) {
      this.deps.log.warn(`${this.variant.id} could not persist the account snapshot: ${errorText(error)}`)
    }
  }

  /**
   * Point the route at an account identity, invalidating whatever the previous
   * one left behind. One helper for all transitions (sign-in, sign-out, account
   * switch); every transition bumps the catalog generation, which makes an
   * in-flight request from before the change refuse to write back.
   */
  private async adoptIdentity(identity: string | undefined, account: string | undefined): Promise<void> {
    if (this.lastIdentity === identity) {
      this.visibilityAccount = account
      return
    }
    const known = this.lastIdentity
    this.lastIdentity = identity
    this.visibilityAccount = account
    this.catalogGeneration += 1
    this.inflightCatalog?.controller.abort()
    this.inflightCatalog = undefined
    // Credits are billed to one account; never carry the previous account's
    // quota into the new one, and never join its in-flight usage read.
    this.creditsRaw = undefined
    this.creditsUpdatedAt = undefined
    this.creditsError = undefined
    this.usageFlight = new SingleFlight<ProviderActionResult>()
    this.checkinActivity = undefined
    this.checkinFetchedAt = 0
    this.checkinCatchUpAttempted = false
    if (identity === undefined) {
      // Signed out: hide the group, drop the models, and forget this account's
      // saved catalog — it is that account's data.
      if (known !== undefined) await this.savedCatalogs.delete(known)
      this.catalog.set(this.variant.region === 'global' ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS)
      this.catalogSource = 'builtin'
      this.catalogFetchedAtMs = undefined
      this.catalogError = undefined
      if (this.catalog.setVisible(false)) this.invalidateAdapter()
      else this.deps.notifyChanged()
      return
    }
    // Serve this account's best-known catalog until a fetch lands: the saved one
    // is what this account (from this source) was actually served, which is
    // preferred over the built-in snapshot.
    const saved = this.savedCatalogs.get(identity)
    if (saved !== undefined) {
      this.catalog.set([...saved.models])
      this.catalogSource = 'saved'
      this.catalogFetchedAtMs = saved.fetchedAtMs
    } else {
      this.catalog.set(this.variant.region === 'global' ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS)
      this.catalogSource = 'builtin'
      this.catalogFetchedAtMs = undefined
    }
    this.catalogError = undefined
    this.catalog.setVisible(true)
    this.invalidateAdapter()
  }

  /**
   * Fetch the catalog for the current credential.
   *
   * Shared by init, the poll, and the manual action, and written so concurrent
   * callers cost one request: a second caller joins the in-flight fetch instead
   * of starting its own, and a response whose generation moved on is discarded
   * rather than overwriting newer state. Returns false when the answer was
   * discarded that way, so an action does not claim an update that never
   * happened.
   */
  private async fetchCatalog(): Promise<boolean> {
    let credential: WorkBuddyCredential
    try {
      credential = await this.credentials.resolve()
    } catch (error: unknown) {
      // The credential exists but cannot be used (no sign-in, or an expired
      // token whose refresh failed). Serving models now would only offer calls
      // that fail, so the group is hidden until a credential works again.
      this.credentialError = this.redact(errorText(error)).slice(0, 300)
      if (this.catalog.setVisible(false)) this.invalidateAdapter()
      else this.deps.notifyChanged()
      throw error
    }
    this.credentialError = undefined
    this.rememberResolvedCredential(credential)
    const identity = accountKeyOf(credential)
    if (this.lastIdentity !== identity) {
      await this.adoptIdentity(identity, visibilityAccountOf(credential))
    }
    const generation = this.catalogGeneration
    const inflight = this.inflightCatalog
    if (inflight !== undefined && inflight.identity === identity && inflight.generation === generation) {
      return inflight.promise
    }
    inflight?.controller.abort()
    const controller = new AbortController()
    let run: Promise<boolean>
    run = (async (): Promise<boolean> => {
      try {
        const models = await this.client.fetchModels(credential, controller.signal)
        if (this.disposed || this.catalogGeneration !== generation) return false
        // The account can change while the request is in flight; re-read before
        // publishing so the just-finished document belongs to the account that
        // is selected now.
        const latest = await this.credentials.current().catch(() => undefined)
        const latestIdentity = latest === undefined ? undefined : accountKeyOf(latest)
        if (latestIdentity !== identity) {
          await this.adoptIdentity(latestIdentity, latest === undefined ? undefined : visibilityAccountOf(latest))
          if (latestIdentity !== undefined) await this.fetchCatalog()
          return false
        }
        const fetchedAtMs = this.client.lastCatalog?.fetchedAtMs ?? this.clock()
        this.catalog.set([...models])
        this.catalogSource = 'live'
        this.catalogFetchedAtMs = fetchedAtMs
        this.catalogError = undefined
        this.lastFetchAtMs = this.clock()
        if (this.lastIdentity === identity) {
          await this.savedCatalogs.set(identity, {
            source: this.client.lastCatalog?.source ?? 'unknown',
            fetchedAtMs,
            models: [...models],
            ...(this.client.lastCatalog?.appVersion === undefined
              ? {}
              : { appVersion: this.client.lastCatalog.appVersion.version }),
          })
        }
        this.invalidateAdapter()
        return true
      } catch (error: unknown) {
        if (this.disposed || this.catalogGeneration !== generation) return false
        this.lastFetchAtMs = this.clock()
        this.catalogError = this.redact(errorText(error)).slice(0, 300)
        const source = this.catalogSource === 'builtin' ? '内置列表' : '上次保存的列表'
        this.deps.log.warn(`${this.variant.id} 模型目录刷新失败，继续使用${source}: ${this.catalogError}`)
        this.deps.notifyChanged()
        // A published error is not a discarded answer; the caller reports the
        // catalog failure from `catalogError`.
        return true
      } finally {
        if (this.inflightCatalog?.controller === controller) this.inflightCatalog = undefined
        this.deps.notifyChanged()
      }
    })()
    this.inflightCatalog = { identity, generation, controller, promise: run }
    return run
  }

  /**
   * Fetch the billed usage answer and publish it as the route's quota.
   *
   * Called by the explicit action, `refreshAll`, and the background first-load,
   * sign-in/switch and periodic reads. Single-flight: concurrent callers share
   * one billed request.
   */
  private async refreshUsage(): Promise<ProviderActionResult> {
    this.usageReads += 1
    try {
      return await this.usageFlight.run(async () => {
        // The identity this flight is allowed to bill. An account adopted while
        // the credential resolves belongs to a different read — the sweep starts
        // that account's own read — so continuing here would bill it twice and
        // could publish a failure against state that no longer describes it.
        const generationAtEntry = this.catalogGeneration
        let credential: WorkBuddyCredential
        try {
          credential = await this.credentials.resolve()
        } catch (error: unknown) {
          if (this.disposed || generationAtEntry !== this.catalogGeneration) {
            throw new ProviderActionError('stale_identity', '账号已切换，已丢弃旧账号的额度结果')
          }
          const message = this.redact(errorText(error)).slice(0, 300)
          this.credentialError = message
          this.creditsError = message
          this.deps.notifyChanged()
          throw new ProviderActionError('usage_refresh_failed', `额度刷新失败：${message}`)
        }
        if (this.disposed || generationAtEntry !== this.catalogGeneration) {
          throw new ProviderActionError('stale_identity', '账号已切换，已丢弃旧账号的额度结果')
        }
        const identity = accountKeyOf(credential)
        if (this.lastIdentity !== identity) {
          await this.adoptIdentity(identity, visibilityAccountOf(credential))
        }
        const generation = this.catalogGeneration
        let credits: WorkBuddyCredits
        try {
          credits = await this.client.fetchCredits(credential)
        } catch (error: unknown) {
          if (this.disposed || generation !== this.catalogGeneration) {
            throw new ProviderActionError('stale_identity', '账号已切换，已丢弃旧账号的额度结果')
          }
          const message = this.redact(errorText(error)).slice(0, 300)
          this.creditsError = message
          this.deps.notifyChanged()
          throw new ProviderActionError('usage_refresh_failed', `额度刷新失败：${message}`)
        }
        // The account can change while the billed request is in flight. Decide
        // staleness outside the fetch's catch: throwing stale_identity from
        // inside it was re-wrapped as usage_refresh_failed when the generation
        // had not moved (an out-of-band credential change).
        const latest = await this.credentials.current().catch(() => undefined)
        const latestIdentity = latest === undefined ? undefined : accountKeyOf(latest)
        if (this.disposed || generation !== this.catalogGeneration || latestIdentity !== identity) {
          throw new ProviderActionError('stale_identity', '账号已切换，已丢弃旧账号的额度结果')
        }
        this.creditsRaw = credits
        this.creditsUpdatedAt = this.clock()
        this.creditsError = undefined
        this.deps.notifyChanged()
        const total = credits.unlimited === true ? '不限额度' : `${credits.total} 积分`
        return { message: `额度已刷新：${total}`, code: 'usage-refreshed' }
      })
    } finally {
      this.usageReads -= 1
    }
  }

  private async refreshAccount(): Promise<ProviderActionResult> {
    await this.syncAccount()
    if (!this.credentialsResolved()) {
      const message =
        this.authStatus.state === 'signed-out' && this.authStatus.reason !== undefined
          ? `无法读取 ${this.variant.appName} 登录状态：${this.authStatus.reason}`
          : `未找到 ${this.variant.appName} 桌面端登录；请先在 ${this.variant.appName} 桌面端登录一次`
      throw new ProviderActionError('not_configured', message)
    }
    await this.fetchCatalog().catch(() => undefined)
    const label = this.accountSnapshot?.label ?? this.variant.appName
    return { message: `已读取登录状态：${label}`, code: 'login-imported', params: { account: label } }
  }

  private checkinName(): string {
    return `workbuddy:${this.variant.id}:checkin`
  }

  /** Arm the daily UTC+8 timer; harmless when signed out or disabled. */
  private armCheckin(): void {
    this.deps.scheduler.clear(this.checkinName())
    if (this.disposed || !this.started) return
    if (this.variant.region !== 'cn' || !this.checkinPrefs.enabled || !this.credentialsResolved()) return
    this.deps.scheduler.atUtc8Minute(this.checkinName(), this.checkinPrefs.minute, async () => {
      if (this.disposed || !this.credentialsResolved() || !this.checkinPrefs.enabled) return
      await this.claimCheckin().catch((error: unknown) => {
        this.deps.log.warn(`${this.variant.id} 自动签到失败：${this.redact(errorText(error))}`)
      })
    })
  }

  /** Read the official activity without letting a failure escape. */
  private refreshCheckinInBackground(reason: string): void {
    void this.refreshCheckin().catch((error: unknown) => {
      if (this.disposed) return
      // Throttle the next attempt on the slow poll instead of letting a
      // persistent failure log on every usage refresh.
      this.checkinFetchedAt = this.clock()
      this.deps.log.warn(`${this.variant.id} 签到状态读取失败（${reason}）：${this.redact(errorText(error))}`)
    })
  }

  private async refreshCheckin(): Promise<void> {
    if (this.disposed || this.variant.region !== 'cn' || !this.credentialsResolved()) return
    const generation = this.catalogGeneration
    const credential = await this.credentials.resolve()
    if (this.disposed || generation !== this.catalogGeneration || !this.credentialsResolved()) return
    const activity = await this.client.fetchCheckinStatus(credential)
    if (this.disposed || generation !== this.catalogGeneration) return
    this.checkinActivity = activity
    this.checkinFetchedAt = this.clock()
    if (activity !== undefined && activity.todayCheckedIn) {
      this.checkinPrefs = {
        ...this.checkinPrefs,
        claimedDate: utc8DateOf(this.clock()),
        ...(activity.todayCredit > 0 ? { reward: activity.todayCredit } : {}),
      }
      await this.writeCheckinPrefs()
    }
    this.deps.notifyChanged()
    this.maybeCatchUpCheckin()
  }

  /** One catch-up claim per process after startup or enabling the schedule. */
  private maybeCatchUpCheckin(): void {
    if (this.checkinCatchUpAttempted) return
    if (!shouldCatchUp(this.checkinPrefs, this.checkinActivity, this.credentialsResolved(), this.clock())) return
    this.checkinCatchUpAttempted = true
    void this.claimCheckin().catch((error: unknown) => {
      if (this.disposed) return
      this.deps.log.warn(`${this.variant.id} 补签失败：${this.redact(errorText(error))}`)
    })
  }

  /** Manual check-in: claim today's activity reward or explain why it cannot. */
  private async claimCheckin(): Promise<ProviderActionResult> {
    return await this.checkinFlight.run(async () => {
      if (this.disposed) return {}
      if (this.variant.region !== 'cn') {
        throw new ProviderActionError('unsupported', 'WorkBuddy 国际版暂不支持签到')
      }
      if (!this.credentialsResolved()) {
        throw new ProviderActionError('not_configured', '未找到 WorkBuddy 桌面端登录，请先登录桌面端')
      }
      const credential = await this.credentials.resolve()
      const activity = await this.client.fetchCheckinStatus(credential).catch(() => this.checkinActivity)
      if (this.disposed) return {}
      if (activity !== undefined) {
        this.checkinActivity = activity
        this.checkinFetchedAt = this.clock()
      }
      const current = this.checkinActivity
      if (current === undefined || !current.active) {
        await this.logCheckinRow({ at: this.clock(), ok: false, message: '当前账号暂无可领取的签到活动', code: 'checkin-no-campaign' })
        throw new ProviderActionError('checkin_no_campaign', '当前账号暂无可领取的签到活动')
      }
      if (current.todayCheckedIn) {
        this.checkinPrefs = {
          ...this.checkinPrefs,
          lastAttemptAt: this.clock(),
          claimedDate: utc8DateOf(this.clock()),
          ...(current.todayCredit > 0 ? { reward: current.todayCredit } : {}),
        }
        await this.logCheckinRow({ at: this.clock(), ok: true, message: '今日已签到', code: 'checkin-already' })
        await this.writeCheckinPrefs()
        return { message: '今日已签到', code: 'checkin-already' }
      }
      const claim = await this.client.claimDailyCheckin(credential)
      if (!claim.ok) {
        this.checkinPrefs = { ...this.checkinPrefs, lastAttemptAt: this.clock(), lastErrorAt: this.clock() }
        await this.logCheckinRow({
          at: this.clock(),
          ok: false,
          message: `签到失败：${claim.message}`,
          code: 'checkin-failed-reason',
          params: { reason: claim.message.slice(0, 160) },
        })
        await this.writeCheckinPrefs()
        throw new ProviderActionError('checkin_failed', claim.message)
      }
      this.checkinPrefs = {
        ...this.checkinPrefs,
        lastAttemptAt: this.clock(),
        claimedDate: utc8DateOf(this.clock()),
        reward: claim.credit,
      }
      delete this.checkinPrefs.lastErrorAt
      this.checkinActivity = current === undefined ? this.checkinActivity : { ...current, todayCheckedIn: true, todayCredit: claim.credit }
      await this.logCheckinRow({
        at: this.clock(),
        ok: true,
        message: `签到成功，获得 ${claim.credit} 积分`,
        code: 'checkin-claimed',
        params: { reward: claim.credit },
      })
      await this.writeCheckinPrefs()
      this.refreshUsageInBackground('签到成功')
      this.deps.notifyChanged()
      return {
        message: `签到成功，获得 ${claim.credit} 积分`,
        code: 'checkin-claimed',
        params: { reward: claim.credit },
      }
    })
  }

  private async setCheckin(
    action: Extract<HubAction, { type: 'set-checkin' }>,
  ): Promise<ProviderActionResult> {
    const minute = action.minute === undefined ? this.checkinPrefs.minute : normalizeCheckinMinute(action.minute)
    if (minute === null) throw new ProviderActionError('invalid_request', '签到时间无效')
    const enabled = action.enabled === undefined ? this.checkinPrefs.enabled : action.enabled
    this.checkinPrefs = { ...this.checkinPrefs, enabled, minute }
    await this.writeCheckinPrefs()
    this.checkinCatchUpAttempted = false
    this.armCheckin()
    if (enabled) {
      this.refreshCheckinInBackground('开启签到')
      this.maybeCatchUpCheckin()
    }
    if (action.enabled === undefined && action.minute !== undefined) {
      return { message: `签到时间已设为 ${formatCheckinMinute(minute)}（UTC+8）`, code: 'checkin-time-set', params: { time: formatCheckinMinute(minute) } }
    }
    return enabled
      ? { message: `自动签到已开启，每天 ${formatCheckinMinute(minute)}（UTC+8）`, code: 'checkin-schedule-on', params: { time: formatCheckinMinute(minute) } }
      : { message: '自动签到已关闭', code: 'checkin-schedule-off' }
  }

  private async clearCheckinLog(): Promise<ProviderActionResult> {
    this.checkinPrefs = { ...this.checkinPrefs, log: [] }
    await this.writeCheckinPrefs()
    return { message: '签到记录已清空', code: 'checkin-log-cleared' }
  }

  private async logCheckinRow(row: CheckinLogRow): Promise<void> {
    this.checkinPrefs = withCheckinLog(this.checkinPrefs, row)
    await this.writeCheckinPrefs()
  }

  private async writeCheckinPrefs(): Promise<void> {
    await this.deps.prefs.set(this.keys['checkin']!, this.checkinPrefs)
    this.deps.notifyChanged()
  }

  private async refreshCatalog(): Promise<ProviderActionResult> {
    let published: boolean
    try {
      published = await this.fetchCatalog()
    } catch (error: unknown) {
      const message = this.redact(errorText(error)).slice(0, 300)
      throw new ProviderActionError('catalog_refresh_failed', `模型目录刷新失败：${message}`)
    }
    if (!published) {
      throw new ProviderActionError('stale_identity', '账号已切换，已丢弃过期的模型目录结果')
    }
    if (this.catalogError !== undefined) {
      throw new ProviderActionError('catalog_refresh_failed', `模型目录刷新失败：${this.catalogError}`)
    }
    return { message: `模型目录已刷新（${this.catalog.current().length} 个模型）`, code: 'catalog-refreshed', params: { count: this.catalog.current().length } }
  }

  private async setModelsEnabled(modelIds: readonly string[], enabled: boolean): Promise<ProviderActionResult> {
    const account = this.visibilityAccount
    if (account === undefined) {
      throw new ProviderActionError('identity_unavailable', '登录凭证缺少账号标识，请重新读取登录后再保存模型偏好')
    }
    const known = new Set(this.catalog.current().map((entry) => entry.id))
    let changed = 0
    for (const modelId of [...new Set(modelIds)]) {
      if (!known.has(modelId)) continue
      try {
        await this.visibility.setVisible(account, modelId, enabled)
        changed += 1
      } catch (error: unknown) {
        throw new ProviderActionError('preference_write_failed', `模型偏好保存失败：${this.redact(errorText(error)).slice(0, 200)}`)
      }
    }
    if (changed > 0) {
      this.invalidateAdapter()
      this.deps.notifyChanged()
    }
    return {
      message: enabled ? `已启用 ${changed} 个模型` : `已停用 ${changed} 个模型`,
      code: enabled ? 'models-enabled' : 'models-disabled',
      params: { count: changed },
    }
  }

  private async setMaxContext(useMax: boolean): Promise<ProviderActionResult> {
    if (this.variant.region !== 'global') {
      throw new ProviderActionError('unsupported', '仅 WorkBuddy AI 支持切换最大上下文窗口')
    }
    const catalogChanged = this.catalog.setUseMaximumContextWindow(useMax)
    const changed = this.useMaxContext !== useMax || catalogChanged
    this.useMaxContext = useMax
    await this.deps.prefs.set(this.keys['maxContext']!, useMax)
    if (changed) this.invalidateAdapter()
    this.deps.notifyChanged()
    return {
      message: useMax ? '已切换为最大上下文窗口' : '已切换为默认上下文窗口',
      code: useMax ? 'max-context-on' : 'max-context-off',
    }
  }

  private async setProbeConsent(consent: boolean): Promise<ProviderActionResult> {
    this.probeConsent = consent
    await this.deps.prefs.set(this.keys['consent']!, consent)
    this.deps.notifyChanged()
    return {
      message: consent ? '已开启推理档位探测' : '已关闭推理档位探测',
      code: consent ? 'probe-consent-on' : 'probe-consent-off',
    }
  }

  private async probeModel(modelId: string): Promise<ProviderActionResult> {
    if (!this.probeConsent) {
      throw new ProviderActionError('probe_forbidden', '未开启推理档位探测授权，探测会消耗额度')
    }
    const info = this.catalog.current().find((entry) => entry.id === modelId)
    if (info === undefined) throw new ProviderActionError('unknown_model', `模型不存在：${modelId}`)
    if (!isProbeCandidate(info)) return { message: `${info.name} 无需探测推理档位`, code: 'probe-skipped', params: { model: info.name } }
    this.probingModelId = modelId
    try {
      const result = await this.probeService.probe(modelId)
      if (result.state === 'unavailable') {
        throw new ProviderActionError('probe_failed', `探测失败：${result.reason}`)
      }
      if (result.validation === 'validating') {
        this.invalidateAdapter()
        if (result.efforts.length === 0) {
          return { message: `${info.name} 未接受任何推理档位`, code: 'probe-no-levels', params: { model: info.name }, data: result }
        }
        const levels = result.efforts.join(' / ')
        return { message: `${info.name} 可用推理档位：${levels}`, code: 'probe-levels', params: { model: info.name, levels }, data: result }
      }
      return { message: `${info.name} 的上游未校验推理档位参数，无法判断`, code: 'probe-inconclusive', params: { model: info.name }, data: result }
    } finally {
      this.probingModelId = undefined
      this.deps.notifyChanged()
    }
  }

  /**
   * One-click availability test for a list of models.
   *
   * Each model gets one minimal streaming request — user-started and gated on
   * the probe authorization because it spends real credit. Stops on the first
   * authentication failure: every later probe would only repeat that answer.
   */
  private async testModels(modelIds: readonly string[]): Promise<ProviderActionResult> {
    if (!this.probeConsent) {
      throw new ProviderActionError('probe_forbidden', '未开启推理档位探测授权，模型测试会消耗额度')
    }
    if (modelIds.length === 0) throw new ProviderActionError('invalid_request', '请选择要测试的模型')
    let credential: WorkBuddyCredential
    try {
      credential = await this.credentials.resolve()
    } catch (error: unknown) {
      throw new ProviderActionError('probe_failed', `模型测试失败：${this.redact(errorText(error)).slice(0, 300)}`)
    }
    const known = new Set(this.catalog.current().map((entry) => entry.id))
    const results = await this.modelTestFlight.run(async () => {
      const rows: { modelId: string, verdict: string, detail?: string }[] = []
      for (const rawId of [...new Set(modelIds)]) {
        const modelId = rawId.trim()
        if (!known.has(modelId)) {
          rows.push({ modelId, verdict: 'unknown-model' })
          continue
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS)
        try {
          const attempt = await this.client.probeEffort(credential, modelId, undefined, controller.signal)
          rows.push({ modelId, verdict: verdictOf(attempt), ...(attempt.detail === undefined ? {} : { detail: attempt.detail }) })
          if (verdictOf(attempt) === 'auth') break
        } catch (error: unknown) {
          rows.push({ modelId, verdict: 'error', detail: this.redact(errorText(error)).slice(0, 200) })
        } finally {
          clearTimeout(timer)
        }
      }
      return rows
    })
    const available = results.filter((row) => row.verdict === 'available').length
    const authFailed = results.some((row) => row.verdict === 'auth')
    const suffix = authFailed ? '；登录状态无效，请重新登录桌面端' : ''
    return {
      message: `模型测试完成：${available}/${results.length} 可用${suffix}`,
      code: authFailed ? 'models-tested-auth' : 'models-tested',
      params: { available, total: results.length },
      data: { results },
    }
  }

  private async startTransport(): Promise<void> {
    if (this.transport !== undefined || this.skipTransport) return
    const shim = createWorkBuddyShim({
      store: this.credentials,
      client: { chatStream: (credential, body, signal) => this.client.chatStream(credential, body, signal) },
      catalog: this.catalog,
      logger: { warn: (message) => this.deps.log.warn(message), error: (message) => this.deps.log.error(message) },
    })
    try {
      await shim.ready
    } catch (error: unknown) {
      this.transportError = `本地转发端点启动失败：${this.redact(errorText(error)).slice(0, 200)}`
      this.deps.log.error(`${this.variant.id} loopback endpoint failed to start: ${errorText(error)}`)
      void shim.close().catch(() => undefined)
      return
    }
    try {
      const adapter = createWorkBuddyAdapter({
        providerId: this.variant.id,
        displayName: this.variant.displayName,
        region: this.variant.region,
        shim,
        catalog: this.catalog,
        resolveAttachments: () => this.serviceOf<AttachmentStore>('attachments'),
        resolveImageAccess: (attachments, ref) =>
          resolveImageAttachmentAccess(attachments, (hostPath) => this.processPath(hostPath), ref),
        observe: (modelId) => this.probeService.recordFor(modelId),
        hidden: () =>
          this.visibilityAccount === undefined ? [] : this.visibility.disabled(this.visibilityAccount),
      })
      const release = this.deps.ctx.llm.registerAdapter([this.variant.id], adapter.adapter)
      this.transport = { shim, adapter, release }
      this.deps.log.info(`${this.variant.id} loopback endpoint ready`)
    } catch (error: unknown) {
      this.transportError = `模型适配器注册失败：${this.redact(errorText(error)).slice(0, 200)}`
      this.deps.log.error(`${this.variant.id} adapter registration failed: ${errorText(error)}`)
      void shim.close().catch(() => undefined)
    }
  }

  private releaseTransport(): void {
    const transport = this.transport
    if (transport === undefined) return
    this.transport = undefined
    try {
      transport.release()
    } catch (error: unknown) {
      this.deps.log.warn(`${this.variant.id} adapter release failed: ${errorText(error)}`)
    }
    void transport.shim.close().catch(() => undefined)
  }

  /** Rebuild the adapter snapshot and announce the changed model list. */
  private invalidateAdapter(): void {
    this.transport?.adapter.invalidate()
    this.deps.ctx.emit('llm/adapters-updated')
    this.deps.notifyChanged()
  }

  private serviceOf<T>(name: string): T | undefined {
    const context = this.deps.ctx as unknown as { get?: (service: string) => unknown }
    if (typeof context.get !== 'function') return undefined
    try {
      return context.get(name) as T | undefined
    } catch {
      return undefined
    }
  }

  private processPath(hostPath: string): string | undefined {
    const fs = this.serviceOf<{ processPathFromHostPath?: (path: string) => string | undefined }>('fs')
    return fs?.processPathFromHostPath?.(hostPath)
  }

  private ensureAppVersion(): void {
    // Resolve the international App version early so the first catalog request
    // does not pay for a synchronous filesystem walk in its critical section.
    void this.appVersion().catch(() => undefined)
  }

  private redact(text: string): string {
    return redactHome(redactText(text), this.deps.paths.home)
  }

  private credentialView(): WorkBuddyCredentialView | undefined {
    const credential = this.lastCredential
    if (credential === undefined) return undefined
    const masked = maskToken(credential.accessToken)
    return {
      source: credential.source === 'desktop' ? 'app' : 'plugin',
      writable: false,
      ...(credential.expiresAtMs > 0 ? { expiresAt: credential.expiresAtMs } : {}),
      ...(credential.refreshExpiresAtMs === undefined
        ? {}
        : { refreshExpiresAt: credential.refreshExpiresAtMs }),
      ...(masked === undefined ? {} : { masked }),
    }
  }

  private accountView(): WorkBuddyStatusInput['account'] {
    const snapshot = this.accountSnapshot
    const credential = this.lastCredential
    if (this.authStatus.state !== 'signed-in' || credential === undefined) return {}
    const label =
      maskAccountLabel(credential.nickname)
      ?? snapshot?.label
      ?? (credential.uid === '' ? this.variant.appName : `uid ${credential.uid.slice(-4)}`)
    const detail = accountDetailOf(credential) ?? snapshot?.detail
    return {
      label,
      ...(detail === undefined ? {} : { detail }),
      ...(credential.enterpriseId !== undefined && credential.enterpriseId !== ''
        ? { enterprise: true }
        : {}),
    }
  }

  private probeRows(
    models: readonly WorkBuddyUpstreamModel[],
    records: ReadonlyMap<string, WorkBuddyProbeRecord>,
  ): ProbeView[] {
    const rows: ProbeView[] = []
    for (const info of models) {
      const record = records.get(info.id)
      if (record === undefined) {
        // A model with an undeclared effort set is a probe candidate; listing it
        // is the only way the card can offer the detection button.
        if (isProbeCandidate(info)) rows.push({ modelId: info.id, modelName: info.name, state: 'unknown', efforts: [] })
        continue
      }
      rows.push({
        modelId: info.id,
        modelName: info.name,
        state: probeStateOf(record.validation),
        efforts: [...record.efforts],
        ...(record.validation === 'non-validating'
          ? { message: '上游未校验推理档位参数' }
          : record.validation === 'unknown'
            ? { message: '无法判断推理档位' }
            : {}),
        at: record.probedAtMs,
      })
    }
    const ordered = [...rows].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    if (this.probingModelId === undefined) return ordered
    const name = models.find((entry) => entry.id === this.probingModelId)?.name ?? this.probingModelId
    return [
      { modelId: this.probingModelId, modelName: name, state: 'running', efforts: [] },
      ...ordered.filter((row) => row.modelId !== this.probingModelId),
    ]
  }
}

/** Classify one minimal request for the model-test action. */
function verdictOf(attempt: { status: number, streamed: boolean, errorCode?: string }): string {
  if (attempt.status === 200 && attempt.streamed) return 'available'
  if (attempt.status === 401) return 'auth'
  if (attempt.status === 402) return 'credit'
  if (attempt.status === 429) return 'rate-limited'
  if (attempt.status === 0) return 'unreachable'
  return 'error'
}

/** Build one route's runtime. */
export function createWorkBuddyRuntime(
  deps: ProviderDeps,
  variant: WorkBuddyVariant,
  options: WorkBuddyRuntimeOptions = {},
): WorkBuddyRuntime {
  return new WorkBuddyRuntime(deps, variant, options)
}
