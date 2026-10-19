/**
 * Connection, credential and account section.
 *
 * Every family uses the same three-part layout: an identity block (one account
 * or the Trae account list), one action row, then quiet explanatory copy. The
 * credential's masked tail and expiry horizons live in the identity block as
 * labelled facts, so the source, the account and the token are stated once.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountView, ProviderCredentialView } from '../../shared/contracts.ts'
import {
  actionBusyKey,
  expiryLevel,
  familyLabelOf,
  providerAppName,
  formatDateTime,
  formatNumber,
  localizedServerLabel,
  providerDisplayName,
  warningText,
} from '../format.ts'
import { IconKey, IconRefresh } from '../icons.tsx'
import { AccountMonogram, InlineNote, ProviderStateTag, SectionCard } from '../ui.tsx'
import { useHubUi } from '../ui-context.ts'

/** The connection card: one layout across Qoder, WorkBuddy and Trae. */
export function ConnectionSection(): JSX.Element {
  const { t, provider } = useHubUi()
  return (
    <SectionCard
      title={t('sectionConnection')}
      icon={<IconKey size={14} />}
      meta={(
        <>
          <span className="ch-caption">{providerDisplayName(t, provider.id)}</span>
          <ProviderStateTag state={provider.state} t={t} />
        </>
      )}
    >
      {provider.family === 'trae' ? <TraeConnection key={provider.id} /> : <DesktopConnection key={provider.id} />}
    </SectionCard>
  )
}

type Feedback = { tone: 'success' | 'error'; text: string }

/** One labelled credential value, e.g. "Sign-in expiry 2026-10-22 00:52". */
function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="ch-fact">
      <span className="ch-fact-label">{label}</span>
      <span className="ch-fact-value ch-tabular">{value}</span>
    </span>
  )
}

/** Masked token tail and both expiry horizons of the active credential. */
function CredentialFacts({ credential }: { credential: ProviderCredentialView }): JSX.Element | null {
  const { t } = useHubUi()
  const facts: JSX.Element[] = []
  if (credential.masked !== undefined) {
    facts.push(<Fact key="masked" label={t('credentialLabel')} value={credential.masked} />)
  }
  if (credential.expiresAt !== undefined) {
    facts.push(<Fact key="expires" label={t('accountExpires')} value={formatDateTime(credential.expiresAt)} />)
  }
  if (credential.refreshExpiresAt !== undefined) {
    facts.push(<Fact key="refresh" label={t('accountRefreshExpires')} value={formatDateTime(credential.refreshExpiresAt)} />)
  }
  if (facts.length === 0) return null
  return <div className="ch-id-facts">{facts}</div>
}

/**
 * Monogram, name, badges, one detail line and the credential facts. A family
 * initial replaces the label's first glyph when there is no account name (a
 * PAT or env credential), so the monogram never reads a stray "plugin".
 */
function Identity({ label, monogram, detail, badges, credential }: {
  label: string
  monogram?: string | undefined
  detail?: string | undefined
  badges?: ReactNode
  credential?: ProviderCredentialView | undefined
}): JSX.Element {
  return (
    <div className="ch-id">
      <AccountMonogram label={monogram ?? label} />
      <div className="ch-id-main">
        <div className="ch-id-name">
          <span className="ch-truncate">{label}</span>
          {badges}
        </div>
        {detail === undefined ? null : <div className="ch-id-detail ch-truncate">{detail}</div>}
        {credential === undefined ? null : <CredentialFacts credential={credential} />}
      </div>
    </div>
  )
}

/** Identity, actions, feedback, then hints; extras such as forms follow. */
function ConnectionShell({ identity, actions, feedback, hint, children }: {
  identity: ReactNode
  actions: ReactNode
  feedback?: ReactNode
  hint?: ReactNode
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="ch-conn">
      {identity}
      <div className="ch-actions">{actions}</div>
      {feedback}
      {hint}
      {children}
    </div>
  )
}

/** Qoder and WorkBuddy: a single signed-in account backed by one credential. */
function DesktopConnection(): JSX.Element {
  const { provider } = useHubUi()
  if (provider.family === 'qoder') return <QoderConnection />
  return <WorkBuddyConnection />
}

/**
 * Qoder sign-in: the desktop app's saved sign-in is the primary source, and a
 * manually saved PAT stays available as the fallback that turns automatic
 * import off. The PAT entry only takes space when it is the mode or was asked
 * for; switching back from a saved PAT is confirmed because Qoder may show a
 * PAT only once.
 */
function QoderConnection(): JSX.Element {
  const { t, provider, busy, now, run } = useHubUi()
  const credential = provider.credential
  const account = provider.account
  const appLogin = credential?.source === 'app'
  const envLogin = credential?.source === 'env'
  const patLogin = credential?.source === 'plugin'
  const appLoginStale = appLogin
    && (expiryLevel(credential?.expiresAt, now) === 'expired'
      || provider.warnings.some((warning) => warning.code === 'desktop-credential-rejected'))
  const [patExpanded, setPatExpanded] = useState<boolean | null>(null)
  const [secret, setSecret] = useState('')
  const [patFeedback, setPatFeedback] = useState<Feedback | null>(null)
  const [actionFeedback, setActionFeedback] = useState<Feedback | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [confirmingImport, setConfirmingImport] = useState(false)
  const importKey = actionBusyKey({ type: 'import-desktop-login', provider: provider.id })
  const importing = busy === importKey
  const saving = busy === actionBusyKey({ type: 'save-secret', provider: provider.id })
  const clearing = busy === actionBusyKey({ type: 'clear-secret', provider: provider.id })
  // Start open exactly when the PAT is the current mode; an explicit toggle
  // wins so a failed save is never hidden by an automatic collapse.
  const patOpen = patExpanded ?? patLogin
  const patRegionId = `ch-qoder-pat-${provider.id}`
  const fallbackLabel = appLogin ? t('qoderLoginAppTitle') : envLogin ? t('sourceEnv') : t('qoderLoginPatTitle')

  const importLogin = async (): Promise<void> => {
    setConfirmingImport(false)
    const result = await run({ type: 'import-desktop-login', provider: provider.id })
    setActionFeedback(result.ok
      ? { tone: 'success', text: result.message ?? t('qoderLoginImported') }
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  // A manual PAT may be the only copy the user has (Qoder shows it once), so
  // switching back to the desktop sign-in is confirmed instead of silent.
  const requestImport = (): void => {
    if (patLogin) setConfirmingImport(true)
    else void importLogin()
  }

  const submitPat = async (): Promise<void> => {
    if (secret.trim() === '') {
      setPatFeedback({ tone: 'error', text: t('qoderPatEmpty') })
      return
    }
    const result = await run({ type: 'save-secret', provider: provider.id, secret: secret.trim() })
    if (result.ok) {
      setSecret('')
      setPatFeedback({ tone: 'success', text: result.message ?? t('qoderPatSaved') })
    } else {
      setPatFeedback({ tone: 'error', text: result.error ?? t('actionRejected') })
    }
  }

  const clear = async (): Promise<void> => {
    const result = await run({ type: 'clear-secret', provider: provider.id })
    setConfirmingClear(false)
    setActionFeedback(result.ok
      ? { tone: 'success', text: result.message ?? t('qoderPatCleared') }
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  // Collapsing also dismisses a stale PAT message: the one case where an error
  // is allowed to disappear is an explicit user request to hide the entry.
  const togglePat = (): void => {
    if (patOpen) {
      setPatExpanded(false)
      setPatFeedback(null)
    } else {
      setPatExpanded(true)
    }
  }

  const identity = credential === undefined
    ? <InlineNote>{t('desktopSignInMissing', { app: providerAppName(t, provider.id) })}</InlineNote>
    : (
      <Identity
        label={account?.label ?? fallbackLabel}
        monogram={account === undefined ? familyLabelOf(provider.family) : undefined}
        detail={account?.detail === undefined ? undefined : localizedServerLabel(t, account.detail)}
        badges={credential === undefined
          ? undefined
          : (
            <>
              {appLogin
                ? <Tag tone={appLoginStale ? 'warning' : 'neutral'}>{t('sourceApp')}</Tag>
                : patLogin
                  ? <Tag tone="neutral">{t('qoderLoginPatBadge')}</Tag>
                  : envLogin ? <Tag tone="neutral">{t('sourceEnv')}</Tag> : null}
              {account?.enterprise === true ? <Tag tone="info">{t('accountEnterprise')}</Tag> : null}
            </>
          )}
        credential={credential}
      />
    )

  const actions = (
    <>
      <Button
        variant={credential === undefined ? 'primary' : 'outline'}
        size="sm"
        icon={<IconRefresh size={14} />}
        onClick={requestImport}
        disabled={busy !== null}
      >
        {importing ? t('refreshAccountBusy') : appLogin ? t('refreshAccount') : t('qoderLoginImport')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={patOpen}
        aria-controls={patOpen ? patRegionId : undefined}
        onClick={togglePat}
      >
        {patOpen ? t('qoderLoginHidePat') : t('qoderLoginTogglePat')}
      </Button>
      {credential === undefined
        ? null
        : (
          <Button variant="ghost" size="sm" onClick={() => setConfirmingClear(true)} disabled={busy !== null}>
            {t('qoderPatClear')}
          </Button>
        )}
    </>
  )

  const signInHint = t('desktopSignInHint', { app: providerAppName(t, provider.id) })
  const hint = credential === undefined
    ? <InlineNote>{signInHint}</InlineNote>
    : appLogin
      ? (
        <InlineNote tone={appLoginStale ? 'warn' : 'muted'}>
          {appLoginStale ? t('qoderLoginStale') : signInHint}
        </InlineNote>
      )
      : envLogin
        ? <InlineNote>{t('qoderLoginEnvHint')}</InlineNote>
        : <InlineNote>{t('qoderLoginPatHint')}</InlineNote>

  return (
    <ConnectionShell
      identity={identity}
      actions={actions}
      feedback={actionFeedback === null ? null : <InlineNote tone={actionFeedback.tone}>{actionFeedback.text}</InlineNote>}
      hint={hint}
    >
      {patOpen
        ? (
          <div className="ch-pat" id={patRegionId}>
            <form
              className="ch-pat-row"
              onSubmit={(event) => { event.preventDefault(); void submitPat() }}
            >
              <Input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={t('qoderPatPlaceholder')}
                aria-label={t('qoderPatLabel')}
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
              />
              <Button
                type="submit"
                variant={patLogin ? 'primary' : 'outline'}
                size="sm"
                disabled={busy !== null || secret.trim() === ''}
              >
                {saving ? t('qoderPatSaving') : t('qoderPatSave')}
              </Button>
            </form>
            <div className="ch-hint">{t('qoderPatHint')}</div>
            {patFeedback === null ? null : <InlineNote tone={patFeedback.tone}>{patFeedback.text}</InlineNote>}
          </div>
        )
        : null}
      <Modal
        open={confirmingImport}
        onClose={() => setConfirmingImport(false)}
        title={t('qoderLoginReplacePatTitle')}
        description={t('qoderLoginReplacePatBody')}
        closeLabel={t('close')}
        footer={(
          <div className="ch-row">
            <Button variant="ghost" size="sm" onClick={() => setConfirmingImport(false)}>{t('cancel')}</Button>
            <Button variant="outline" size="sm" onClick={() => { void importLogin() }} disabled={importing}>
              {t('qoderLoginSwitch')}
            </Button>
          </div>
        )}
      />
      <Modal
        open={confirmingClear}
        onClose={() => setConfirmingClear(false)}
        title={t('qoderPatClearTitle', { provider: providerDisplayName(t, provider.id) })}
        description={t('qoderPatClearBody')}
        closeLabel={t('close')}
        footer={(
          <div className="ch-row">
            <Button variant="ghost" size="sm" onClick={() => setConfirmingClear(false)}>{t('cancel')}</Button>
            <Button variant="outline" size="sm" onClick={() => { void clear() }} disabled={clearing}>
              {t('qoderPatClear')}
            </Button>
          </div>
        )}
      />
    </ConnectionShell>
  )
}

/** WorkBuddy reads the desktop app sign-in; the only action is a re-read. */
function WorkBuddyConnection(): JSX.Element {
  const { t, provider, busy, run } = useHubUi()
  const credential = provider.credential
  const account = provider.account
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const refreshing = busy === actionBusyKey({ type: 'refresh-account', provider: provider.id })

  const rescan = async (): Promise<void> => {
    const result = await run({ type: 'refresh-account', provider: provider.id })
    setFeedback(result.ok
      ? { tone: 'success', text: result.message ?? t('done') }
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  const signed = credential !== undefined || account !== undefined
  // The hub's own vault copy is a refreshed app sign-in, the same provenance
  // Trae reports; only a user-pasted PAT is "saved by the plugin".
  const credentialSource = credential === undefined
    ? t('sourceApp')
    : credential.source === 'plugin'
      ? t('sourceAppRefreshed')
      : credential.source === 'env' ? t('sourceEnv') : t('sourceApp')
  const identity = signed
    ? (
      <Identity
        label={account?.label ?? t('sourceApp')}
        monogram={account === undefined ? familyLabelOf(provider.family) : undefined}
        detail={account?.detail === undefined ? undefined : localizedServerLabel(t, account.detail)}
        badges={credential === undefined
          ? undefined
          : (
            <>
              <Tag tone="neutral">{credentialSource}</Tag>
              {account?.enterprise === true ? <Tag tone="info">{t('accountEnterprise')}</Tag> : null}
            </>
          )}
        credential={credential}
      />
    )
    : <InlineNote>{t('desktopSignInMissing', { app: providerAppName(t, provider.id) })}</InlineNote>

  return (
    <ConnectionShell
      identity={identity}
      actions={(
        <Button
          variant={signed ? 'outline' : 'primary'}
          size="sm"
          icon={<IconRefresh size={14} />}
          onClick={() => { void rescan() }}
          disabled={busy !== null}
        >
          {refreshing ? t('refreshAccountBusy') : t('refreshAccount')}
        </Button>
      )}
      feedback={feedback === null ? null : <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>}
      hint={<InlineNote>{t('desktopSignInHint', { app: providerAppName(t, provider.id) })}</InlineNote>}
    />
  )
}

/** Trae: the app sign-in covers several accounts, shown as one selectable list. */
function TraeConnection(): JSX.Element {
  const { t, provider, busy, now, run } = useHubUi()
  const accounts = provider.accounts ?? []
  const credential = provider.credential
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  // Multi-account clients sign in through the app; the hub persists a
  // refreshed copy of that app credential, so the badge names that provenance
  // instead of pretending the user picked one secret.
  const importedCopy = credential?.imported === true
  const refreshedAppCopy = !importedCopy
    && credential !== undefined
    && credential.source === 'plugin'
    && !credential.writable
    && accounts.length > 0
  const source = credential === undefined
    ? undefined
    : importedCopy ? t('sourceImported') : refreshedAppCopy ? t('sourceAppRefreshed') : t('sourceApp')
  const refreshing = busy === actionBusyKey({ type: 'refresh-account', provider: provider.id })
  // The provider may report ready while one account's sign-in is expiring;
  // surface that as a warning instead of a contradictory healthy badge.
  const expiryWarning = provider.warnings.find((warning) => warning.level !== 'info'
    && /expir|refresh|过期|到期/i.test(`${warning.code} ${warning.message}`))
  const expiryText = expiryWarning === undefined ? undefined : warningText(t, expiryWarning)
  // A soon horizon is otherwise only a badge; keep the advice reachable as
  // plain text (a Tooltip anchored on a Tag never receives hover/focus props).
  const expiringSoon = expiryText === undefined && accounts.some((account) =>
    expiryLevel(account.expiresAt, now) === 'soon' || expiryLevel(account.refreshExpiresAt, now) === 'soon')

  const rescan = async (): Promise<void> => {
    const result = await run({ type: 'refresh-account', provider: provider.id })
    setFeedback(result.ok
      ? { tone: 'success', text: result.message ?? t('done') }
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  const select = async (account: AccountView): Promise<void> => {
    if (account.selected) return
    const result = await run({ type: 'select-account', provider: provider.id, accountId: account.id })
    setFeedback(result.ok
      ? { tone: 'success', text: result.message ?? t('done') }
      : { tone: 'error', text: result.error ?? t('actionRejected') })
  }

  const identity = accounts.length === 0
    ? <InlineNote>{t('desktopSignInMissing', { app: providerAppName(t, provider.id) })}</InlineNote>
    : (
      <>
        <div className="ch-acc-head">
          <span className="ch-acc-title">{t('accountsTitle')}</span>
          <span className="ch-caption ch-tabular">{formatNumber(accounts.length)}</span>
          {source === undefined ? null : <Tag tone="neutral">{source}</Tag>}
        </div>
        <div className="ch-accounts" role="radiogroup" aria-label={t('accountsTitle')}>
          {accounts.map((account) => (
            <TraeAccountRow
              key={account.id}
              account={account}
              now={now}
              busy={busy !== null}
              onSelect={() => { void select(account) }}
            />
          ))}
        </div>
      </>
    )

  const hint = (
    <>
      {expiryText === undefined ? null : <InlineNote tone="warn">{expiryText}</InlineNote>}
      {expiringSoon ? <InlineNote tone="warn">{t('accountExpiryHint')}</InlineNote> : null}
      <InlineNote>{t('desktopSignInHint', { app: providerAppName(t, provider.id) })}</InlineNote>
    </>
  )

  return (
    <ConnectionShell
      identity={identity}
      actions={(
        <Button
          variant={accounts.length === 0 ? 'primary' : 'outline'}
          size="sm"
          icon={<IconRefresh size={14} />}
          onClick={() => { void rescan() }}
          disabled={busy !== null}
        >
          {refreshing ? t('refreshAccountBusy') : t('refreshAccounts')}
        </Button>
      )}
      feedback={feedback === null ? null : <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>}
      hint={hint}
    />
  )
}

/** One selectable Trae account: state, edition and both expiry horizons. */
function TraeAccountRow({ account, now, busy, onSelect }: {
  account: AccountView
  now: number
  busy: boolean
  onSelect: () => void
}): JSX.Element {
  const { t } = useHubUi()
  const expiry = expiryLevel(account.expiresAt, now)
  const refreshExpiry = expiryLevel(account.refreshExpiresAt, now)
  const expired = account.state === 'expired' || expiry === 'expired' || refreshExpiry === 'expired'
  const soon = expiry === 'soon' || refreshExpiry === 'soon'
  // One badge per account: an expiry problem wins over the healthy state, so
  // the row never reads "healthy" and "expired" at the same time.
  const badge = account.state === 'error'
    ? <Tag tone="danger">{t('accountStateError')}</Tag>
    : expired
      ? <Tag tone="danger">{t('expiredTag')}</Tag>
      : soon
        ? <Tag tone="warning">{t('expiringTag')}</Tag>
        : <Tag tone="success">{t('accountStateOk')}</Tag>
  const state = account.state === 'error' ? 'error' : expired ? 'expired' : soon ? 'soon' : undefined
  return (
    <label className="ch-account" data-selected={account.selected} data-state={state}>
      <input
        className="ch-radio"
        type="radio"
        name="ch-trae-account"
        checked={account.selected}
        onChange={onSelect}
        disabled={busy}
        aria-label={t('accountSelectAria', { account: account.label })}
      />
      <span className="ch-account-main">
        <span className="ch-account-name">
          <span className="ch-truncate">{account.label}</span>
          {account.selected ? <Tag tone="solid">{t('accountSelectedTag')}</Tag> : null}
          {badge}
        </span>
        <span className="ch-account-facts">
          {account.detail === undefined
            ? null
            : <span className="ch-account-detail ch-truncate">{localizedServerLabel(t, account.detail)}</span>}
          <Fact
            label={t('accountExpires')}
            value={account.expiresAt === undefined ? t('none') : formatDateTime(account.expiresAt)}
          />
          {account.refreshExpiresAt === undefined
            ? null
            : <Fact label={t('accountRefreshExpires')} value={formatDateTime(account.refreshExpiresAt)} />}
        </span>
      </span>
    </label>
  )
}
