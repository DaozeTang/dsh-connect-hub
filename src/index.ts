import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CONNECT_HUB_VERSION } from './shared/version.ts'
import { createHubLogger } from './core/log.ts'
import { profileDirOf, resolveHubPaths } from './core/paths.ts'
import { PrefsStore } from './core/prefs.ts'
import { Scheduler } from './core/scheduler.ts'
import { Vault } from './core/vault.ts'
import { createHubRoute } from './core/http.ts'
import { detectPiAiRuntime } from './core/pi-ai.ts'
import { redactHome, redactText, stripInternalErrorMarkers } from './core/redact.ts'
import { HUB_ROUTE_BASE, type HubAction, type HubStatus, type ProviderStatus, type WarningView } from './shared/contracts.ts'
import { ProviderActionError, type HubRuntimeDeps, type ProviderRuntime } from './core/types.ts'
import { createQoderProviders } from './providers/qoder/index.ts'
import { createWorkBuddyProviders } from './providers/workbuddy/index.ts'
import { createTraeProviders } from './providers/trae/index.ts'

export const name = 'dsh-connect-hub'

export const inject = ['llm']

export async function apply(ctx: Context): Promise<void> {
  const paths = resolveHubPaths({ profileDir: profileDirOf(ctx) })
  const log = createHubLogger(ctx, paths.home)
  const scheduler = new Scheduler(log)
  const prefs = new PrefsStore(paths, log)
  const vault = new Vault(ctx, paths, log)
  let revision = 0
  const notifyChanged = (): void => { revision += 1 }
  const deps: HubRuntimeDeps = {
    ctx,
    paths,
    prefs,
    vault,
    log,
    scheduler,
    version: CONNECT_HUB_VERSION,
    notifyChanged,
  }

  const warnings: WarningView[] = []
  const runtimes: ProviderRuntime[] = [
    ...createQoderProviders(deps),
    ...createWorkBuddyProviders(deps),
    ...createTraeProviders(deps),
  ]
  const byId = new Map(runtimes.map((runtime) => [runtime.descriptor.id, runtime]))
  const key = randomBytes(24).toString('hex')

  const providerStatus = (runtime: ProviderRuntime): ProviderStatus => {
    try {
      return runtime.status()
    } catch (error) {
      log.error(`status failed for ${runtime.descriptor.id}: ${error instanceof Error ? error.message : String(error)}`)
      return {
        id: runtime.descriptor.id,
        family: runtime.descriptor.family,
        region: runtime.descriptor.region,
        label: runtime.descriptor.label,
        state: 'error',
        catalog: { source: 'builtin', models: [] },
        warnings: [{ code: 'status_failed', level: 'error', message: '状态读取失败' }],
        capabilities: { usage: false, checkin: false, transfer: false, probes: false, multiAccount: false },
      }
    }
  }

  const buildStatus = (): HubStatus => ({
    version: CONNECT_HUB_VERSION,
    revision,
    now: Date.now(),
    key,
    warnings: [...warnings],
    providers: runtimes.map(providerStatus),
  })

  const dispatch = async (
    action: HubAction,
  ): Promise<
    | { ok: true; message?: string; code?: string; params?: Readonly<Record<string, string | number>>; data?: unknown }
    | { ok: false; error: string; detail?: string }
  > => {
    if (action.type === 'refresh-status') {
      await Promise.allSettled(runtimes.map((runtime) => runtime.refreshAll()))
      notifyChanged()
      return { ok: true }
    }
    const runtime = byId.get(action.provider)
    if (runtime === undefined) return { ok: false, error: 'provider_unknown' }
    try {
      const result = await runtime.action(action)
      notifyChanged()
      const success: {
        ok: true
        message?: string
        code?: string
        params?: Readonly<Record<string, string | number>>
        data?: unknown
      } = { ok: true }
      if (result.message !== undefined) success.message = result.message
      if (result.code !== undefined) success.code = result.code
      if (result.params !== undefined) success.params = result.params
      if (result.data !== undefined) success.data = result.data
      return success
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      log.warn(`${action.provider} action ${action.type} failed: ${raw}`)
      return {
        ok: false,
        error: error instanceof ProviderActionError ? error.code : 'action_failed',
        detail: redactHome(stripInternalErrorMarkers(redactText(raw)), paths.home),
      }
    }
  }

  let disposed = false
  ctx.effect(() => async () => {
    disposed = true
    scheduler.dispose()
    await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()))
    await prefs.dispose()
  }, 'connect-hub: lifecycle')

  // Provider registration happens before `apply` resolves, so a composition
  // that boots an agent immediately (headless/TUI) sees the adapters on its
  // first model resolution instead of racing an async background setup.
  try {
    await prefs.load()
    const piAi = await detectPiAiRuntime()
    if (piAi.generation === 'legacy') {
      warnings.push({
        code: 'pi-ai-legacy',
        level: 'error',
        message: `插件解析到的 @earendil-works/pi-ai 为 ${piAi.version ?? '未知版本'}（旧代）。请确认 profile 内依赖安装完整后重启 DSH。`,
        at: Date.now(),
      })
      log.error(`pi-ai resolved to legacy ${piAi.version ?? 'unknown'}; transports will fail`)
    }
    for (const runtime of runtimes) {
      if (disposed) return
      await runtime.init().catch((error: unknown) => {
        log.error(`${runtime.descriptor.id} init failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    notifyChanged()
  } catch (error) {
    log.error(`startup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (disposed) return

  // The browser surface is optional: a TUI or headless composition still gets
  // the providers, and the routes appear only while a web server is served.
  ctx.inject(['webServer'], (scope) => {
    try {
      const origin = new URL(scope.webServer.getOrigin())
      if (!['127.0.0.1', '::1', 'localhost'].includes(origin.hostname)) {
        log.warn(`web server origin ${origin.origin} is not loopback; the hub browser surface is local-only`)
      }
    } catch {
      // The listener has not bound yet.
    }
    const allowedHosts = (): readonly string[] => {
      const hosts = new Set<string>()
      try {
        hosts.add(new URL(scope.webServer.getOrigin()).host)
      } catch {
        // The listener has not bound yet; loopback spellings below still cover it.
      }
      const port = scope.webServer.port
      if (port !== undefined) {
        hosts.add(`127.0.0.1:${port}`)
        hosts.add(`localhost:${port}`)
        hosts.add(`[::1]:${port}`)
        hosts.add(`harness.internal:${port}`)
      }
      hosts.add('harness.internal')
      return [...hosts]
    }
    scope.effect(
      () => scope.webServer.register(createHubRoute({
        basePath: HUB_ROUTE_BASE,
        key,
        buildStatus,
        dispatch,
        allowedHosts,
        log: log.child('http'),
      })),
      'connect-hub: http routes',
    )
  })
}
