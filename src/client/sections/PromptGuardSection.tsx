import { useState } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptGuardView } from '../../shared/contracts.ts'
import { actionBusyKey } from '../format.ts'
import { IconShield } from '../icons.tsx'
import { InlineNote, SectionCard } from '../ui.tsx'
import { useHubUi } from '../ui-context.ts'

export function PromptGuardSection(): JSX.Element | null {
  const { t, provider, busy, run } = useHubUi()
  const guard: PromptGuardView | undefined = provider.promptGuard
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  if (guard === undefined) return null
  const toggleBusy = busy === actionBusyKey({ type: 'set-prompt-guard', provider: provider.id })

  const toggle = async (next: boolean): Promise<void> => {
    const result = await run({ type: 'set-prompt-guard', provider: provider.id, enabled: next })
    setFeedback(result.ok
      ? { tone: 'success', text: result.message ?? t('done') }
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  return (
    <SectionCard
      title={t('sectionPromptGuard')}
      icon={<IconShield size={14} />}
      meta={(
        <>
          <Tag tone={guard.enabled ? 'success' : 'warning'}>
            {guard.enabled ? t('promptGuardOn') : t('promptGuardOff')}
          </Tag>
          {guard.rewritten === 0 ? null : (
            <span className="ch-caption">{t('promptGuardRewritten', { count: guard.rewritten })}</span>
          )}
        </>
      )}
    >
      <div className="ch-consent">
        <span className="ch-consent-text">
          <span className="ch-consent-title">{t('promptGuardLabel')}</span>
          <span className="ch-caption">{t('promptGuardHint')}</span>
        </span>
        <Switch
          checked={guard.enabled}
          label={t('promptGuardLabel')}
          onChange={(next) => { void toggle(next) }}
          disabled={busy !== null || toggleBusy}
        />
      </div>
      <InlineNote tone="muted">{t('promptGuardPathNote')}</InlineNote>
      {guard.enabled ? null : <InlineNote tone="warn">{t('promptGuardDisabledWarning')}</InlineNote>}
      {feedback === null ? null : <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>}
    </SectionCard>
  )
}
