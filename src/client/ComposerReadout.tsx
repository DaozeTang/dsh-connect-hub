/**
 * Composer credit readout.
 *
 * Registered in both composer seats (`conversation.input.left` and
 * `conversation.input.dock`); exactly one of them draws, decided by the
 * browser-local seat preference. It renders nothing unless the session's
 * selected model provider is one of this plugin's six routes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  StateDot,
  Tag,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HubStatus, ProviderStatus } from '../shared/contracts.ts'
import {
  creditSummary,
  effectiveCredits,
  findProvider,
  formatCredits,
  formatDateTime,
  formatNumber,
  localizedServerLabel,
  providerDisplayName,
  relativeText,
  selectedAccountOf,
  selectedProviderOf,
  stateDot,
} from './format.ts'
import { useClientPreferences, useComposerStatus } from './hooks.ts'
import { IconRefresh } from './icons.tsx'
import { NS } from './locales.ts'
import type { ComposerSeat } from './prefs.ts'
import { composerStatus } from './status-source.ts'
import { ProviderStateTag } from './ui.tsx'

/** Props shared by both registered seats (owner props are additive per seat). */
export type ComposerReadoutProps = PropsRuntime<'conversation.input.left'>
  & PropsLocale<typeof NS>
  & { seat: ComposerSeat }

type ProjectionReader = (key: string) => unknown

/**
 * The readout gate. `seat` names the registration that mounted this instance;
 * the shared preference picks exactly one winner.
 */
export function ComposerReadout({ useProjection, t, seat }: ComposerReadoutProps): JSX.Element | null {
  const preferences = useClientPreferences()
  const readProjection = useProjection as unknown as ProjectionReader
  const providerId = selectedProviderOf(readProjection('modelSelection'))
  const visible = providerId !== undefined && preferences.seat === seat
  const { status, refreshing, error, loadedAt } = useComposerStatus()
  const provider = providerId === undefined ? undefined : findProvider(status, providerId)

  const [open, setOpen] = useState(false)
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, gap: 8, margin: 12, side: 'top' })

  useEffect(() => {
    if (visible) composerStatus.ensureFresh()
  }, [visible, providerId])

  useEffect(() => {
    if (!visible && open) setOpen(false)
  }, [visible, open])

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      anchorRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  const refresh = useCallback(async (): Promise<void> => {
    setManualRefreshing(true)
    try {
      await composerStatus.refresh()
    } finally {
      setManualRefreshing(false)
    }
  }, [])

  if (!visible || providerId === undefined) return null

  const name = providerDisplayName(t, providerId)
  const summary = readoutSummary(t, provider)
  const wrapperClass = seat === 'dock' ? 'ch-dock-row' : 'ch-readout-wrap'

  return (
    <span className={wrapperClass} ref={rootRef}>
      <button
        ref={anchorRef}
        type="button"
        className="ch-readout"
        data-open={open}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('readoutAria', { provider: name, value: summary })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ch-readout-dot" data-state={provider === undefined ? 'idle' : stateDot(provider.state)}>
          <StateDot state={provider === undefined ? 'idle' : stateDot(provider.state)} size={10} />
        </span>
        <span className="ch-readout-name">{name}</span>
        <span className="ch-readout-sep" aria-hidden="true">·</span>
        <span className="ch-readout-value">{summary}</span>
      </button>
      {open
        ? createPortal(
          <div
            ref={panelRef}
            className="ch-popover"
            role="dialog"
            aria-label={t('popoverTitle', { provider: name })}
            style={position ?? { visibility: 'hidden' }}
            tabIndex={-1}
          >
            <div className="ch-popover-head">
              <span className="ch-popover-title ch-truncate">{t('popoverTitle', { provider: name })}</span>
            </div>
            <PopoverBody t={t} status={status} provider={provider} />
            {error === null ? null : <div className="ch-popover-error">{t('popoverRefreshFailed', { message: error })}</div>}
            <div className="ch-popover-actions">
              <span className="ch-caption">
                {loadedAt === null
                  ? t('neverUpdated')
                  : t('popoverUpdated', { time: relativeText(t, loadedAt, Date.now()) })}
              </span>
              <span className="ch-spacer" />
              <Button
                variant="outline"
                size="sm"
                icon={<IconRefresh size={14} />}
                onClick={() => { void refresh() }}
                disabled={refreshing || manualRefreshing}
              >
                {manualRefreshing || refreshing ? t('popoverRefreshing') : t('popoverRefresh')}
              </Button>
            </div>
          </div>,
          document.body,
        )
        : null}
    </span>
  )
}

function readoutSummary(t: ComposerReadoutProps['t'], provider: ProviderStatus | undefined): string {
  if (provider === undefined) return t('readoutUnknown')
  const summary = creditSummary(provider)
  if (summary === undefined) return t('readoutEmpty')
  if (summary.amount !== undefined) return t('readoutCredits', { credits: formatCredits(summary.amount) })
  if (summary.plan !== undefined) return t('readoutPlan', { plan: localizedServerLabel(t, summary.plan) })
  return t('readoutEmpty')
}

function PopoverBody({ t, status, provider }: {
  t: ComposerReadoutProps['t']
  status: HubStatus | null
  provider: ProviderStatus | undefined
}): JSX.Element {
  if (provider === undefined) {
    return <div className="ch-caption">{status === null ? t('loading') : t('popoverNoData')}</div>
  }
  const credits = effectiveCredits(provider)
  const account = provider.account?.label ?? selectedAccountOf(provider)?.label
  const accounts = provider.accounts ?? []
  return (
    <div className="ch-popover-body">
      <div className="ch-popover-row">
        <span className="ch-popover-key">{t('popoverState')}</span>
        <span className="ch-popover-value"><ProviderStateTag state={provider.state} t={t} /></span>
      </div>
      {account === undefined
        ? null
        : (
          <div className="ch-popover-row">
            <span className="ch-popover-key">{t('popoverAccount')}</span>
            <span className="ch-popover-value ch-truncate">{account}</span>
          </div>
        )}
      {credits === undefined
        ? <div className="ch-caption">{t('popoverNoData')}</div>
        : (
          <>
            <div className="ch-popover-row">
              <span className="ch-popover-key">{t('popoverCredits')}</span>
              <span className="ch-popover-value ch-tabular">
                {credits.remaining === undefined ? t('none') : formatCredits(credits.remaining)}
                {credits.plan === undefined ? null : <span className="ch-caption"> · {localizedServerLabel(t, credits.plan)}</span>}
              </span>
            </div>
            {credits.updatedAt === undefined
              ? null
              : (
                <div className="ch-popover-row">
                  <span className="ch-popover-key">{t('creditsUpdatedAt', { time: '' }).trim()}</span>
                  <span className="ch-popover-value ch-tabular">{formatDateTime(credits.updatedAt)}</span>
                </div>
              )}
            {credits.packages.length === 0
              ? null
              : (
                <div className="ch-popover-row">
                  <span className="ch-popover-key">{t('popoverPackages')}</span>
                  <span className="ch-popover-value ch-tabular">{formatNumber(credits.packages.length)}</span>
                </div>
              )}
          </>
        )}
      {accounts.length > 1
        ? (
          <div className="ch-popover-accounts">
            <span className="ch-caption">{t('popoverAccounts')}</span>
            {accounts.map((item) => (
              <div className="ch-popover-account" key={item.id} data-selected={item.selected}>
                <span className="ch-popover-account-name ch-truncate">{item.label}</span>
                {item.selected ? <Tag tone="solid">{t('accountSelectedTag')}</Tag> : null}
                <span className="ch-caption ch-tabular">
                  {item.credits?.remaining === undefined ? t('none') : formatCredits(item.credits.remaining)}
                </span>
              </div>
            ))}
          </div>
        )
        : null}
    </div>
  )
}
