/** Credits and usage section: balance, plan, and per-package progress. */

import { useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreditsPackage, CreditsView } from '../../shared/contracts.ts'
import {
  actionBusyKey,
  effectiveCredits,
  formatCredits,
  formatDateTime,
  localizedServerLabel,
  packageExpiryLevel,
  progressPercent,
} from '../format.ts'
import { IconCoins, IconRefresh } from '../icons.tsx'
import { EmptyState, InlineNote, ProgressBar, SectionCard } from '../ui.tsx'
import { useHubUi } from '../ui-context.ts'

const KIND_LABEL_KEY = {
  credits: 'creditsKindCredits',
  subscription: 'creditsKindSubscription',
  enterprise: 'creditsKindEnterprise',
} as const

/** Usage card; hidden by the page when the provider does not claim usage. */
export function CreditsSection(): JSX.Element {
  const { t, provider, busy, now, run } = useHubUi()
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const credits = effectiveCredits(provider)
  const refreshKey = actionBusyKey({ type: 'refresh-usage', provider: provider.id })
  const refreshing = busy === refreshKey

  const refresh = async (): Promise<void> => {
    const result = await run({ type: 'refresh-usage', provider: provider.id })
    setFeedback(result.ok
      ? { tone: 'success', text: result.message ?? t('done') }
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  const meta = (
    <>
      {credits === undefined ? null : <Tag tone="neutral">{t(KIND_LABEL_KEY[credits.kind])}</Tag>}
      <Button
        variant="ghost"
        size="sm"
        icon={<IconRefresh size={14} />}
        onClick={() => { void refresh() }}
        disabled={busy !== null || !provider.capabilities.usage}
      >
        {refreshing ? t('refreshing') : t('refreshUsage')}
      </Button>
    </>
  )

  return (
    <SectionCard title={t('sectionCredits')} icon={<IconCoins size={14} />} meta={meta}>
      {credits === undefined
        ? <EmptyState title={t('creditsEmpty')} />
        : <CreditsBody credits={credits} now={now} />}
      {feedback === null ? null : <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>}
    </SectionCard>
  )
}

function CreditsBody({ credits, now }: { credits: CreditsView; now: number }): JSX.Element {
  const { t } = useHubUi()
  const remaining = credits.remaining
  const total = credits.total
  const percent = progressPercent(remaining, total)
  const tone = percent === undefined ? 'accent' : percent < 15 ? 'danger' : percent < 35 ? 'warn' : 'accent'
  return (
    <>
      {credits.error === undefined ? null : (
        <InlineNote tone="warn">{t('creditsError', { message: credits.error })}</InlineNote>
      )}
      <div className="ch-credit-hero">
        <div>
          <div className="ch-caption">{t('creditsRemaining')}</div>
          <div className="ch-credit-value">
            <span className="ch-credit-number">{remaining === undefined ? t('none') : formatCredits(remaining)}</span>
            {remaining === undefined ? null : <span className="ch-credit-unit">{t('creditsUnit')}</span>}
          </div>
        </div>
        <div className="ch-credit-side">
          {credits.plan === undefined ? null : (
            <div className="ch-row" style={{ gap: 6 }}>
              <span className="ch-caption">{t('creditsPlan')}</span>
              <Tag tone="info">{localizedServerLabel(t, credits.plan)}</Tag>
            </div>
          )}
          {total === undefined ? null : <div className="ch-caption">{t('creditsTotal', { total: formatCredits(total) })}</div>}
          {credits.resetAt === undefined ? null : <div className="ch-caption">{t('creditsResetAt', { time: formatDateTime(credits.resetAt) })}</div>}
          {credits.updatedAt === undefined ? null : <div className="ch-caption">{t('creditsUpdatedAt', { time: formatDateTime(credits.updatedAt) })}</div>}
        </div>
      </div>
      {percent === undefined ? null : <ProgressBar percent={percent} tone={tone} label={t('creditsRemaining')} />}
      {credits.packages.length === 0
        ? null
        : (
          <div className="ch-packages">
            <div className="ch-caption">{t('creditsPackages')}</div>
            {credits.packages.map((item) => <PackageRow key={item.id} item={item} now={now} />)}
          </div>
        )}
    </>
  )
}

function PackageRow({ item, now }: { item: CreditsPackage; now: number }): JSX.Element {
  const { t } = useHubUi()
  const percent = progressPercent(item.remaining, item.total)
  const expiry = packageExpiryLevel(item, now)
  return (
    <div className="ch-package">
      <div className="ch-package-head">
        <span className="ch-package-name ch-truncate">{localizedServerLabel(t, item.name ?? item.id)}</span>
        {expiry === undefined || expiry === 'ok' || item.expiresAt === undefined
          ? null
          : (
            <Tag tone={expiry === 'expired' ? 'danger' : 'warning'}>
              {expiry === 'expired' ? t('expiredTag') : t('expiringTag')}
            </Tag>
          )}
        <span className="ch-package-meta">
          {item.expiresAt === undefined ? null : <span className="ch-tabular">{formatDateTime(item.expiresAt)}</span>}
          <span className="ch-tabular">
            {item.total === undefined
              ? t('creditsPackageRemaining', { remaining: formatCredits(item.remaining) })
              : t('creditsPackageLine', { remaining: formatCredits(item.remaining), total: formatCredits(item.total) })}
          </span>
        </span>
      </div>
      {percent === undefined ? null : <ProgressBar percent={percent} tone={percent < 15 ? 'danger' : percent < 35 ? 'warn' : 'accent'} label={localizedServerLabel(t, item.name ?? item.id)} />}
    </div>
  )
}
