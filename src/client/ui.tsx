/** Small presentational compositions shared by every settings section. */

import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CheckinState, ProviderStatus } from '../shared/contracts.ts'
import type { ConnectHubTranslate } from './format.ts'
import { relativeText } from './format.ts'
import { IconInfo, IconWarning } from './icons.tsx'

/** One settings card with a title row and an optional trailing meta cluster. */
export function SectionCard({ title, icon, meta, children, className }: {
  title: string
  icon?: ReactNode
  meta?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={className === undefined ? 'ch-card' : `ch-card ${className}`}>
      <header className="ch-card-head">
        {icon === undefined ? null : <span className="ch-card-icon" aria-hidden="true">{icon}</span>}
        <h3 className="ch-card-title">{title}</h3>
        {meta === undefined ? null : <div className="ch-card-meta">{meta}</div>}
      </header>
      {children}
    </section>
  )
}

/** Inline one-line feedback: muted hint, success confirmation or honest error. */
export function InlineNote({ tone = 'muted', children }: {
  tone?: 'muted' | 'error' | 'success' | 'warn'
  children: ReactNode
}): JSX.Element {
  return (
    <div className="ch-inline-note" data-tone={tone}>
      {tone === 'error' || tone === 'warn' ? <IconWarning size={13} /> : null}
      <span>{children}</span>
    </div>
  )
}

/** A standalone banner for load failures and connection advice. */
export function Banner({ tone, children }: { tone: 'info' | 'warn' | 'error'; children: ReactNode }): JSX.Element {
  return (
    <div className="ch-banner" data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
      <span className="ch-banner-icon" aria-hidden="true">
        {tone === 'error' || tone === 'warn' ? <IconWarning size={15} /> : <IconInfo size={15} />}
      </span>
      <div className="ch-grow">{children}</div>
    </div>
  )
}

/** Centered empty state with an optional action. */
export function EmptyState({ icon, title, body, action }: {
  icon?: ReactNode
  title: string
  body?: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="ch-empty">
      {icon === undefined ? <IconInfo size={20} /> : icon}
      <div className="ch-empty-title">{title}</div>
      {body === undefined ? null : <div className="ch-empty-body">{body}</div>}
      {action}
    </div>
  )
}

/** Credit balance progress. `tone` warns when the remainder is nearly spent. */
export function ProgressBar({ percent, tone = 'accent', label }: {
  percent: number | undefined
  tone?: 'accent' | 'warn' | 'danger'
  label: string
}): JSX.Element {
  const width = percent === undefined ? 0 : Math.round(percent)
  return (
    <div
      className="ch-progress"
      data-tone={tone === 'accent' ? undefined : tone}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={width}
    >
      <i style={{ width: `${width}%` }} />
    </div>
  )
}

const PROVIDER_STATE_TONE: Record<ProviderStatus['state'], TagTone> = {
  ready: 'success',
  'needs-credential': 'warning',
  'signed-out': 'warning',
  error: 'danger',
}

/** Localized state tag for a provider route. */
export function ProviderStateTag({ state, t }: { state: ProviderStatus['state']; t: ConnectHubTranslate }): JSX.Element {
  const label = state === 'ready'
    ? t('stateReady')
    : state === 'needs-credential'
      ? t('stateNeedsCredential')
      : state === 'signed-out'
        ? t('stateSignedOut')
        : t('stateError')
  return <Tag tone={PROVIDER_STATE_TONE[state]}>{label}</Tag>
}

const CHECKIN_STATE_TONE: Record<CheckinState, TagTone> = {
  available: 'info',
  claimed: 'success',
  'device-used': 'warning',
  unknown: 'neutral',
  error: 'danger',
}

/** Localized check-in state tag. */
export function CheckinStateTag({ state, t }: { state: CheckinState; t: ConnectHubTranslate }): JSX.Element {
  const label = state === 'available'
    ? t('checkinStateAvailable')
    : state === 'claimed'
      ? t('checkinStateClaimed')
      : state === 'device-used'
        ? t('checkinStateDeviceUsed')
        : state === 'error'
          ? t('checkinStateError')
          : t('checkinStateUnknown')
  return <Tag tone={CHECKIN_STATE_TONE[state]}>{label}</Tag>
}

/** Initial glyph for an account row (it is presentation, not an avatar asset). */
export function AccountMonogram({ label }: { label: string }): JSX.Element {
  const initial = Array.from(label.trim())[0] ?? '?'
  return <span className="ch-monogram" aria-hidden="true">{initial}</span>
}

/** Loading skeleton matching the settings page's hub bar and card geometry. */
export function SettingsSkeleton({ label }: { label: string }): JSX.Element {
  return (
    <div className="ch-root" role="status" aria-label={label}>
      <div className="ch-skeleton-bar">
        <div className="ch-row">
          <div className="ch-skeleton" style={{ width: 88, height: 30, borderRadius: 999 }} />
          <div className="ch-skeleton" style={{ width: 104, height: 30, borderRadius: 999 }} />
          <div className="ch-skeleton" style={{ width: 82, height: 30, borderRadius: 999 }} />
        </div>
        <div className="ch-row" style={{ minHeight: 28 }}>
          <div className="ch-skeleton" style={{ width: 110, height: 12 }} />
          <span className="ch-spacer" />
          <div className="ch-skeleton" style={{ width: 84, height: 28, borderRadius: 8 }} />
        </div>
      </div>
      <div className="ch-skeleton-card">
        <div className="ch-row">
          <div className="ch-skeleton" style={{ width: 30, height: 30, borderRadius: 999 }} />
          <div className="ch-grow" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div className="ch-skeleton" style={{ width: 180, height: 14 }} />
            <div className="ch-skeleton" style={{ width: 240, height: 11 }} />
          </div>
        </div>
        <div className="ch-row">
          <div className="ch-skeleton" style={{ width: 132, height: 28, borderRadius: 8 }} />
          <div className="ch-skeleton" style={{ width: 110, height: 28, borderRadius: 8 }} />
        </div>
      </div>
      <div className="ch-skeleton-card">
        <div className="ch-skeleton" style={{ width: 120, height: 14 }} />
        <div className="ch-skeleton" style={{ width: '100%', height: 44, borderRadius: 12 }} />
      </div>
    </div>
  )
}

/** A short relative-time string for a timestamp. */
export function relativeTimeText(t: ConnectHubTranslate, at: number, now: number): string {
  return relativeText(t, at, now)
}
