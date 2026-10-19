/** Provider diagnostics: honest, non-alarming list of already-redacted messages. */

import type { WarningView } from '../../shared/contracts.ts'
import { warningText } from '../format.ts'
import { IconError, IconInfo, IconWarning } from '../icons.tsx'
import { SectionCard, relativeTimeText } from '../ui.tsx'
import { useHubUi } from '../ui-context.ts'

const LEVEL_ICON = {
  info: IconInfo,
  warn: IconWarning,
  error: IconError,
} as const

/** Rendered only when the provider reports at least one warning to show. */
export function WarningsSection({ warnings }: { warnings: readonly WarningView[] }): JSX.Element {
  const { t, now } = useHubUi()
  return (
    <SectionCard
      title={t('warningsTitle')}
      icon={<IconWarning size={14} />}
      meta={<span className="ch-caption">{t('warningsCount', { count: warnings.length })}</span>}
    >
      <div className="ch-warnings">
        {warnings.map((warning, index) => (
          <WarningRow key={`${warning.code}-${index}`} warning={warning} now={now} />
        ))}
      </div>
    </SectionCard>
  )
}

function WarningRow({ warning, now }: { warning: WarningView; now: number }): JSX.Element {
  const { t } = useHubUi()
  const Icon = LEVEL_ICON[warning.level]
  return (
    <div className="ch-warning" data-level={warning.level}>
      <span className="ch-warning-icon" aria-hidden="true"><Icon size={14} /></span>
      <span className="ch-warning-message">{warningText(t, warning)}</span>
      <span className="ch-warning-time">
        {warning.level === 'info' ? t('warningInfo') : warning.level === 'warn' ? t('warningWarn') : t('warningError')}
        {warning.at === undefined ? null : ` · ${relativeTimeText(t, warning.at, now)}`}
      </span>
    </div>
  )
}
