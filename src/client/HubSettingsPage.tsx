/**
 * The one settings surface: registered as the `dsh-connect-hub` entry of
 * `plugins.bundle.config`, rendered on the bundle page in Plugins.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, SegmentedControl, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HubAction, HubStatus, ProviderStatus } from '../shared/contracts.ts'
import { FAMILIES } from '../shared/contracts.ts'
import { runAction } from './api.ts'
import {
  actionBusyKey,
  familyHealth,
  findProvider,
  providerIdOf,
  stateDot,
  warningText,
} from './format.ts'
import { actionErrorText, actionSuccessText } from './format.ts'
import type { ConnectHubTranslate, FamilyHealth } from './format.ts'
import { useClientPreferences, useHubStatusSource } from './hooks.ts'
import { IconClose, IconError, IconInfo, IconRefresh, IconWarning } from './icons.tsx'
import { clientPreferences } from './prefs.ts'
import { CheckinSection } from './sections/CheckinSection.tsx'
import { ConnectionSection } from './sections/ConnectionSection.tsx'
import { CreditsSection } from './sections/CreditsSection.tsx'
import { ModelsSection } from './sections/ModelsSection.tsx'
import { PreferencesSection } from './sections/PreferencesSection.tsx'
import { ProbesSection } from './sections/ProbesSection.tsx'
import { PromptGuardSection } from './sections/PromptGuardSection.tsx'
import { TransferSection } from './sections/TransferSection.tsx'
import { WarningsSection } from './sections/WarningsSection.tsx'
import { describeError } from './status-source.ts'
import type { RunResult } from './ui-context.ts'
import { HubUiContext } from './ui-context.ts'
import { Banner, EmptyState, SettingsSkeleton } from './ui.tsx'

export interface HubSettingsPageProps {
  t: ConnectHubTranslate
}

/** Whole settings surface: hub bar, then the shown provider's sections. */
export function HubSettingsPage({ t }: HubSettingsPageProps): JSX.Element {
  const { snapshot, source } = useHubStatusSource()
  const preferences = useClientPreferences()
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const status = snapshot.status
  const now = status?.now ?? Date.now()

  const run = useCallback(async (action: HubAction): Promise<RunResult> => {
    setBusy(actionBusyKey(action))
    try {
      const result = await runAction(action)
      if (result.ok) {
        source.apply(result.status)
        const success: RunResult = { ok: true, status: result.status }
        const message = actionSuccessText(t, result)
        if (message !== undefined) success.message = message
        if (result.data !== undefined) success.data = result.data
        return success
      }
      return { ok: false, error: actionErrorText(t, result) }
    } catch (error) {
      return { ok: false, error: t('networkError', { message: describeError(error) }) }
    } finally {
      setBusy(null)
    }
  }, [source, t])

  const runOptimistic = useCallback(async (
    action: HubAction,
    project: (current: HubStatus) => HubStatus,
  ): Promise<RunResult> => {
    const previous = source.mutate(project)
    const result = await run(action)
    if (!result.ok && previous !== null) source.apply(previous)
    return result
  }, [run, source])

  const hubWarnings = status?.warnings ?? []
  const warningCodes = hubWarnings.map((warning) => warning.code).join('\u0000')
  useEffect(() => {
    setDismissed((previous) => {
      const present = new Set(hubWarnings.map((warning) => warning.code))
      const next = new Set([...previous].filter((code) => present.has(code)))
      return next.size === previous.size ? previous : next
    })
    // Re-show a previously dismissed notice when its code reappears.
  }, [warningCodes])

  if (status === null) {
    if (snapshot.error !== null) {
      return (
        <div className="ch-root">
          <div className="ch-card">
            <Banner tone="error">
              <div>{t('loadErrorTitle')}</div>
              <div className="ch-caption">{t('loadErrorBody', { message: snapshot.error })}</div>
            </Banner>
            <div className="ch-row">
              <Button variant="outline" size="sm" icon={<IconRefresh size={14} />} onClick={() => { void source.refresh() }}>
                {t('retry')}
              </Button>
            </div>
          </div>
        </div>
      )
    }
    return <SettingsSkeleton label={t('loading')} />
  }

  const family = preferences.family
  const region = preferences.region
  const familyProviderCount = FAMILIES.find((entry) => entry.id === family)?.providers.length ?? 0
  const provider = findProvider(status, providerIdOf(family, region))
  const health = familyHealth(status)
  const refreshingAll = busy === actionBusyKey({ type: 'refresh-status' })
  const visibleWarnings = hubWarnings.filter((warning) => !dismissed.has(warning.code))

  const refreshAll = async (): Promise<void> => {
    const result = await run({ type: 'refresh-status' })
    setNotice(result.ok
      ? (result.message === undefined ? null : { tone: 'success', text: result.message })
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  const dismissWarning = (code: string): void => {
    setDismissed((previous) => new Set([...previous, code]))
  }

  return (
    <div className="ch-root">
      <h2 className="ch-sr-only">{t('title')}</h2>
      <header className="ch-hubbar">
        <div className="ch-hubbar-main">
          <div className="ch-families" role="group" aria-label={t('familyAria')}>
            {health.map((item) => (
              <button
                key={item.family}
                type="button"
                className="ch-family"
                data-active={item.family === family}
                aria-pressed={item.family === family}
                onClick={() => clientPreferences.setFamily(item.family)}
              >
                <StateDot state={stateDot(item.state)} />
                <span className="ch-family-name">{item.label}</span>
                <span className="ch-family-state">
                  {healthLabel(t, item.state)}
                  {item.partial ? ` ${item.ready}/${item.total}` : ''}
                </span>
              </button>
            ))}
          </div>
          {familyProviderCount > 1
            ? (
              <SegmentedControl
                id="ch-region"
                className="ch-region"
                value={region}
                label={t('regionAria')}
                options={[
                  { value: 'cn', label: t('regionCn') },
                  { value: 'global', label: t('regionGlobal') },
                ]}
                onChange={(next) => clientPreferences.setRegion(next)}
              />
            )
            : null}
        </div>
        <div className="ch-hubbar-side">
          <span className="ch-caption ch-tabular">
            {t('lastUpdated', { time: relativeUpdated(t, snapshot.loadedAt ?? now, now) })}
          </span>
          <span className="ch-spacer" />
          <Button
            variant="outline"
            size="sm"
            icon={<IconRefresh size={14} />}
            onClick={() => { void refreshAll() }}
            disabled={refreshingAll}
          >
            {refreshingAll ? t('refreshing') : t('refresh')}
          </Button>
        </div>
      </header>

      {visibleWarnings.map((warning) => (
        <div
          className="ch-banner"
          data-tone={warning.level === 'info' ? 'info' : warning.level}
          role={warning.level === 'error' ? 'alert' : undefined}
          key={warning.code}
        >
          <span className="ch-banner-icon" aria-hidden="true">
            {warning.level === 'info' ? <IconInfo size={15} /> : warning.level === 'warn' ? <IconWarning size={15} /> : <IconError size={15} />}
          </span>
          <div className="ch-grow">{warningText(t, warning)}</div>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconClose size={14} />}
            aria-label={t('close')}
            onClick={() => dismissWarning(warning.code)}
          />
        </div>
      ))}

      {snapshot.error === null ? null : (
        <div className="ch-notice" data-tone="error" role="status">
          <IconWarning size={14} />
          <span className="ch-grow">{t('offlineHint', { message: snapshot.error })}</span>
          <Button variant="ghost" size="sm" onClick={() => { void source.refresh() }}>{t('retry')}</Button>
        </div>
      )}
      {notice === null ? null : (
        <div className="ch-notice" data-tone={notice.tone} role="status">
          <span className="ch-grow">{notice.text}</span>
          <Button variant="ghost" size="sm" icon={<IconClose size={14} />} aria-label={t('close')} onClick={() => setNotice(null)} />
        </div>
      )}

      {/* The region control is a tablist; point its active tab at this panel. */}
      <div
        className="ch-sections"
        id={familyProviderCount > 1 ? `ch-region-${region}-panel` : undefined}
        role={familyProviderCount > 1 ? 'tabpanel' : undefined}
        aria-labelledby={familyProviderCount > 1 ? `ch-region-${region}` : undefined}
      >
        {status.providers.length === 0
          ? (
            <div className="ch-card">
              <EmptyState
                title={t('emptyTitle')}
                body={t('emptyBody')}
                action={(
                  <Button variant="outline" size="sm" icon={<IconRefresh size={14} />} onClick={() => { void refreshAll() }}>
                    {t('refreshNow')}
                  </Button>
                )}
              />
            </div>
          )
          : provider === undefined
            ? (
              <div className="ch-card">
                <EmptyState
                  title={t('emptyProviderTitle')}
                  body={t('emptyProviderBody')}
                  action={(
                    <Button variant="outline" size="sm" icon={<IconRefresh size={14} />} onClick={() => { void refreshAll() }}>
                      {t('refreshNow')}
                    </Button>
                  )}
                />
              </div>
            )
            : (
              <ProviderSections
                key={provider.id}
                t={t}
                status={status}
                provider={provider}
                busy={busy}
                now={now}
                run={run}
                runOptimistic={runOptimistic}
              />
            )}
      </div>

      {familyProviderCount > 1
        ? (
          <div
            id={`ch-region-${region === 'cn' ? 'global' : 'cn'}-panel`}
            role="tabpanel"
            aria-labelledby={`ch-region-${region === 'cn' ? 'global' : 'cn'}`}
            hidden
          />
        )
        : null}

      <PreferencesSection t={t} />
    </div>
  )
}

function ProviderSections({ t, status, provider, busy, now, run, runOptimistic }: {
  t: ConnectHubTranslate
  status: HubStatus
  provider: ProviderStatus
  busy: string | null
  now: number
  run: (action: HubAction) => Promise<RunResult>
  runOptimistic: (action: HubAction, project: (current: HubStatus) => HubStatus) => Promise<RunResult>
}): JSX.Element {
  // A capability without a credential has no surface: Qoder reports usage and
  // check-in as unavailable while signed out, and the other two must not show
  // empty cards for the same state. One signed-in test gates all of them so a
  // signed-out page looks the same for every provider. A multi-account client
  // is configured by its account list; a single-account one by its credential.
  const configured = provider.capabilities.multiAccount
    ? (provider.accounts?.length ?? 0) > 0
    : provider.credential !== undefined
  const showUsage = provider.capabilities.usage && configured
  const showCheckin = provider.capabilities.checkin && configured && provider.checkin?.supported !== false
  const showProbes = provider.capabilities.probes && configured
  const showTransfer = provider.capabilities.transfer && provider.transfer?.supported !== false && configured
  // While signed out, the connection card already says the sign-in is missing
  // and offers the fix, so repeating that one informational notice in
  // diagnostics is noise. A warning at another level or with another code
  // (e.g. a read failure with a reason) always stays.
  const warnings = configured
    ? provider.warnings
    : provider.warnings.filter((warning) => !(warning.level === 'info' && SIGN_IN_WARNING_CODES.has(warning.code)))

  return (
    <HubUiContext.Provider value={{ t, status, provider, busy, now, run, runOptimistic }}>
      <ConnectionSection />
      {showUsage && showCheckin
        ? (
          <div className="ch-split">
            <CreditsSection />
            <CheckinSection />
          </div>
        )
        : (
          <>
            {showUsage ? <CreditsSection /> : null}
            {showCheckin ? <CheckinSection /> : null}
          </>
        )}
      <ModelsSection />
      {showProbes ? <ProbesSection /> : null}
      {configured ? <PromptGuardSection /> : null}
      {showTransfer ? <TransferSection /> : null}
      {warnings.length === 0 ? null : <WarningsSection warnings={warnings} />}
    </HubUiContext.Provider>
  )
}

/**
 * Warning codes that only restate the connection card's "not signed in" note.
 *
 * Qoder's `credential-missing` is deliberately absent: while automatic desktop
 * import is running it says so ("正在读取…"), and when the import is off it
 * names both recovery paths — information the card does not repeat.
 */
const SIGN_IN_WARNING_CODES: ReadonlySet<string> = new Set([
  'no-credential',
  'no_account',
])

function healthLabel(t: ConnectHubTranslate, state: FamilyHealth['state']): string {
  switch (state) {
    case 'ready': return t('stateReady')
    case 'needs-credential': return t('stateNeedsCredential')
    case 'signed-out': return t('stateSignedOut')
    case 'error': return t('stateError')
    default: return t('stateUnknown')
  }
}

function relativeUpdated(t: ConnectHubTranslate, at: number, now: number): string {
  const delta = Math.max(0, now - at)
  if (delta < 60_000) return t('relativeNow')
  if (delta < 3_600_000) return t('relativeMinutes', { n: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('relativeHours', { n: Math.floor(delta / 3_600_000) })
  return t('relativeDays', { n: Math.floor(delta / 86_400_000) })
}
