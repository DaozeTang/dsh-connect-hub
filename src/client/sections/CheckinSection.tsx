/** Daily check-in section: schedule, state, per-account rows and the log. */

import { useState } from 'react'
import { Button, Input, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountView, CheckinLogRow, CheckinView, HubAction } from '../../shared/contracts.ts'
import {
  actionBusyKey,
  checkinLogText,
  effectiveCheckin,
  formatClockMinute,
  formatDateTime,
  formatNumber,
  nextCheckinAt,
  parseClockMinute,
  selectedAccountOf,
} from '../format.ts'
import { IconCalendar, IconCheck, IconClose } from '../icons.tsx'
import { CheckinStateTag, InlineNote, SectionCard, relativeTimeText } from '../ui.tsx'
import { useHubUi } from '../ui-context.ts'

/** Check-in card, rendered only when the provider claims the capability. */
export function CheckinSection(): JSX.Element {
  const { t, provider, busy, now, run } = useHubUi()
  const checkin = effectiveCheckin(provider)
  const accounts = provider.accounts ?? []
  const [timeDraft, setTimeDraft] = useState<string | null>(null)
  const [timeError, setTimeError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const minute = checkin?.minute ?? 0
  const enabled = checkin?.enabled ?? false
  const timeValue = timeDraft ?? formatClockMinute(minute)
  const log = checkin?.log ?? []
  const selected = selectedAccountOf(provider)
  // A multi-account client may still report one account; that row checks in
  // with an explicit account id, so the busy key has to carry it too.
  const singleAccountId = accounts.length === 1 ? selected?.id : undefined
  const checkingIn = busy === (singleAccountId === undefined
    ? actionBusyKey({ type: 'checkin', provider: provider.id })
    : actionBusyKey({ type: 'checkin', provider: provider.id, accountId: singleAccountId }))
  const savingSchedule = busy === actionBusyKey({ type: 'set-checkin', provider: provider.id })

  const notify = (result: { ok: boolean; error?: string | undefined; message?: string | undefined }): void => {
    setFeedback(result.ok
      ? { tone: 'success', text: result.message ?? t('done') }
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  const saveTime = async (): Promise<void> => {
    const parsed = parseClockMinute(timeValue)
    if (parsed === undefined) {
      setTimeError(t('checkinTimeInvalid'))
      return
    }
    setTimeError(null)
    if (parsed === minute) {
      setTimeDraft(null)
      return
    }
    const result = await run({ type: 'set-checkin', provider: provider.id, minute: parsed })
    if (result.ok) setTimeDraft(null)
    notify(result)
  }

  const setEnabled = async (next: boolean): Promise<void> => {
    notify(await run({ type: 'set-checkin', provider: provider.id, enabled: next }))
  }

  const checkIn = async (account?: AccountView): Promise<void> => {
    const action: HubAction = account === undefined
      ? { type: 'checkin', provider: provider.id }
      : { type: 'checkin', provider: provider.id, accountId: account.id }
    notify(await run(action))
  }

  const clearLog = async (): Promise<void> => {
    notify(await run({ type: 'clear-checkin-log', provider: provider.id }))
  }

  return (
    <SectionCard
      title={t('sectionCheckin')}
      icon={<IconCalendar size={14} />}
      meta={checkin === undefined ? null : <CheckinStateTag state={checkin.state} t={t} />}
    >
      <div className="ch-checkin-grid">
        <div className="ch-row">
          <div className="ch-pref-copy">
            <div className="ch-pref-title">{t('checkinAuto')}</div>
            <div className="ch-caption">
              {enabled ? t('checkinTimeHint', { time: formatClockMinute(minute) }) : t('checkinInactive')}
            </div>
          </div>
          <Switch
            checked={enabled}
            label={t('checkinAuto')}
            onChange={(next) => { void setEnabled(next) }}
            disabled={busy !== null}
          />
        </div>
        <form
          className="ch-checkin-controls"
          onSubmit={(event) => { event.preventDefault(); void saveTime() }}
        >
          <div className="ch-checkin-time">
            <label className="ch-label" htmlFor={`ch-checkin-time-${provider.id}`}>{t('checkinTimeLabel')}</label>
            <Input
              id={`ch-checkin-time-${provider.id}`}
              type="time"
              value={timeValue}
              onChange={(event) => { setTimeDraft(event.target.value); setTimeError(null) }}
              aria-label={t('checkinTimeLabel')}
              disabled={busy !== null}
            />
            <Tag tone="neutral">{t('checkinUtc8')}</Tag>
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={busy !== null || savingSchedule}>
            {t('save')}
          </Button>
        </form>
        {timeError === null ? null : <InlineNote tone="error">{timeError}</InlineNote>}
        {checkin?.lastRunAt === undefined && !enabled && !(checkin?.state === 'claimed' && checkin.reward !== undefined)
          ? null
          : (
            <div className="ch-row-wrap ch-caption">
              {checkin?.lastRunAt === undefined
                ? null
                : <span>{t('checkinLastRun', { time: relativeTimeText(t, checkin.lastRunAt, now) })}</span>}
              {enabled ? <span>{t('checkinNextRun', { time: formatDateTime(nextCheckinAt(minute, now)) })}</span> : null}
              {checkin?.state === 'claimed' && checkin.reward !== undefined
                ? <Tag tone="success">{t('checkinReward', { reward: formatNumber(checkin.reward) })}</Tag>
                : null}
            </div>
          )}
        <InlineNote>{t('checkinHint')}</InlineNote>
        {accounts.length > 1
          ? (
            <div className="ch-accounts">
              <div className="ch-caption">{t('checkinPerAccount')}</div>
              {accounts.map((account) => (
                <AccountCheckinRow
                  key={account.id}
                  account={account}
                  now={now}
                  busy={busy !== null}
                  checking={busy === actionBusyKey({ type: 'checkin', provider: provider.id, accountId: account.id })}
                  onCheckin={() => { void checkIn(account) }}
                />
              ))}
            </div>
          )
          : null}
        {accounts.length > 1
          ? null
          : (
            <div className="ch-row">
              <Button
                variant="primary"
                size="sm"
                onClick={() => { void checkIn(selected) }}
                disabled={busy !== null || checkin?.state === 'claimed' || checkin?.state === 'device-used'}
              >
                {checkingIn ? t('checkinBusy') : t('checkinNow')}
              </Button>
            </div>
          )}
        <div className="ch-divider" />
        <div className="ch-row">
          <div className="ch-card-title">{t('checkinLog')}</div>
          <span className="ch-spacer" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void clearLog() }}
            disabled={busy !== null || log.length === 0}
          >
            {t('checkinClearLog')}
          </Button>
        </div>
        {log.length === 0
          ? <InlineNote>{t('checkinLogEmpty')}</InlineNote>
          : (
            <div className="ch-checkin-log">
              {log.map((row) => <CheckinLogLine key={`${row.at}-${row.message}`} row={row} />)}
            </div>
          )}
        {feedback === null ? null : <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>}
      </div>
    </SectionCard>
  )
}

function AccountCheckinRow({ account, now, busy, checking, onCheckin }: {
  account: AccountView
  now: number
  busy: boolean
  checking: boolean
  onCheckin: () => void
}): JSX.Element {
  const { t } = useHubUi()
  const checkin: CheckinView | undefined = account.checkin
  return (
    <div className="ch-row" style={{ padding: '4px 2px' }}>
      <span className="ch-truncate" style={{ maxWidth: 180 }}>{account.label}</span>
      {checkin === undefined
        ? <span className="ch-caption">{t('none')}</span>
        : <CheckinStateTag state={checkin.state} t={t} />}
      {checkin?.state === 'claimed' && checkin.reward !== undefined
        ? <span className="ch-caption">{t('checkinReward', { reward: formatNumber(checkin.reward) })}</span>
        : null}
      {checkin?.lastRunAt === undefined
        ? null
        : <span className="ch-caption">{relativeTimeText(t, checkin.lastRunAt, now)}</span>}
      <span className="ch-spacer" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onCheckin}
        disabled={busy || checkin?.state === 'claimed' || checkin?.state === 'device-used'}
      >
        <span className="ch-sr-only">{account.label}</span>
        {checking ? t('checkinBusy') : t('checkinNow')}
      </Button>
    </div>
  )
}

function CheckinLogLine({ row }: { row: CheckinLogRow }): JSX.Element {
  const { t } = useHubUi()
  const text = checkinLogText(t, row)
  return (
    <div className="ch-log-row">
      <span className="ch-log-time">{formatDateTime(row.at)}</span>
      <span className={row.ok ? 'ch-log-ok' : 'ch-log-fail'} aria-hidden="true">
        {row.ok ? <IconCheck size={13} /> : <IconClose size={13} />}
      </span>
      <span className="ch-log-message ch-truncate" title={text}>{text}</span>
    </div>
  )
}
