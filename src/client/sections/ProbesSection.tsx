/** Reasoning-probe section: consent gate, per-model runs, honest results. */

import { useState } from 'react'
import { Button, StateDot, Switch, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProbeView } from '../../shared/contracts.ts'
import { actionBusyKey } from '../format.ts'
import { IconShield } from '../icons.tsx'
import { EmptyState, InlineNote, SectionCard, relativeTimeText } from '../ui.tsx'
import { useHubUi } from '../ui-context.ts'

const PROBE_DOT = {
  unknown: 'idle',
  running: 'ongoing',
  ok: 'done',
  error: 'error',
  inconclusive: 'idle',
} as const

const PROBE_TAG_TONE = {
  unknown: 'quiet',
  running: 'info',
  ok: 'success',
  error: 'danger',
  inconclusive: 'neutral',
} as const

/** Probe card, rendered only when the provider claims the capability. */
export function ProbesSection(): JSX.Element {
  const { t, provider, busy, now, run } = useHubUi()
  const probes = provider.probes
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const consent = probes?.consent ?? false
  const rows = probes?.rows ?? []
  const consentBusy = busy === actionBusyKey({ type: 'set-probe-consent', provider: provider.id })

  const notify = (result: { ok: boolean; error?: string | undefined; message?: string | undefined }): void => {
    setFeedback(result.ok
      ? { tone: 'success', text: result.message ?? t('done') }
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  const setConsent = async (next: boolean): Promise<void> => {
    notify(await run({ type: 'set-probe-consent', provider: provider.id, consent: next }))
  }

  const probe = async (row: ProbeView): Promise<void> => {
    notify(await run({ type: 'probe-model', provider: provider.id, modelId: row.modelId }))
  }

  const probeAll = async (): Promise<void> => {
    notify(await run({ type: 'test-models', provider: provider.id, modelIds: rows.map((row) => row.modelId) }))
  }

  const meta = (
    <>
      <Tag tone={consent ? 'success' : 'warning'}>{consent ? t('probeConsentOn') : t('probeConsentOff')}</Tag>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconShield size={14} />}
        onClick={() => { void probeAll() }}
        disabled={busy !== null || !consent || rows.length === 0}
      >
        {t('probeRunAll')}
      </Button>
    </>
  )

  return (
    <SectionCard title={t('sectionProbes')} icon={<IconShield size={14} />} meta={meta}>
      {probes === undefined || probes.supported === false
        ? <EmptyState title={t('probeNotSupported')} />
        : (
          <>
            <div className="ch-consent">
              <span className="ch-consent-text">
                <span className="ch-consent-title">{t('probeConsent')}</span>
                <span className="ch-caption">{t('probeConsentHint')}</span>
              </span>
              <Switch
                checked={consent}
                label={t('probeConsent')}
                onChange={(next) => { void setConsent(next) }}
                disabled={busy !== null || consentBusy}
              />
            </div>
            <InlineNote tone={consent ? 'warn' : 'muted'}>{t('probeSpendWarning')}</InlineNote>
            {rows.length === 0
              ? <EmptyState title={t('probeEmpty')} />
              : (
                <div className="ch-probe-list">
                  {rows.map((row) => (
                    <div className="ch-probe" key={row.modelId}>
                      <StateDot state={PROBE_DOT[row.state]} />
                      <div className="ch-probe-main">
                        <div className="ch-probe-name">
                          <span className="ch-truncate">{row.modelName !== '' ? row.modelName : row.modelId}</span>
                          <Tag tone={PROBE_TAG_TONE[row.state]}>
                            {row.state === 'ok'
                              ? t('probeStateOk')
                              : row.state === 'error'
                                ? t('probeStateError')
                                : row.state === 'inconclusive'
                                  ? t('probeStateInconclusive')
                                  : row.state === 'running'
                                    ? t('probeStateRunning')
                                    : t('probeStateUnknown')}
                          </Tag>
                        </div>
                        <div className="ch-probe-message">
                          <span className="ch-row-wrap" style={{ gap: 6 }}>
                            {row.efforts.length === 0
                              ? null
                              : (
                                <Tooltip label={t('probeEfforts', { levels: row.efforts.join(' / ') })}>
                                  <span className="ch-tag-row">
                                    {row.efforts.map((effort) => <Tag key={effort} tone="quiet">{effort}</Tag>)}
                                  </span>
                                </Tooltip>
                              )}
                            {row.message === undefined || row.message === '' ? null : <span>{t('probeResult', { message: row.message })}</span>}
                            {row.at === undefined ? null : <span>{t('probeAt', { time: relativeTimeText(t, row.at, now) })}</span>}
                          </span>
                        </div>
                      </div>
                      <div className="ch-probe-action">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('probeModelAria', { model: row.modelName !== '' ? row.modelName : row.modelId })}
                          onClick={() => { void probe(row) }}
                          disabled={busy !== null || !consent || row.state === 'running'}
                        >
                          {row.state === 'ok' || row.state === 'error' ? t('probeRerun') : t('probeRun')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </>
        )}
      {feedback === null ? null : <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>}
    </SectionCard>
  )
}
