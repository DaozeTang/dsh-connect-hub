/** Trae account transfer: explicit export, redacted preview, confirmed import. */

import { useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TransferPreview, TransferPreviewRow } from '../../shared/contracts.ts'
import { actionBusyKey, formatNumber } from '../format.ts'
import { IconExport, IconImport } from '../icons.tsx'
import { InlineNote, SectionCard } from '../ui.tsx'
import { useHubUi } from '../ui-context.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePreview(value: unknown): TransferPreview | null {
  if (!isRecord(value) || !Array.isArray(value.rows)) return null
  const rows: TransferPreviewRow[] = []
  for (const candidate of value.rows) {
    if (!isRecord(candidate)) continue
    if (typeof candidate.id !== 'string' || typeof candidate.label !== 'string') continue
    const region = candidate.region === 'cn' || candidate.region === 'global' ? candidate.region : 'unknown'
    rows.push({
      id: candidate.id,
      label: candidate.label,
      region,
      hasToken: candidate.hasToken === true,
    })
  }
  return { rows, skipped: typeof value.skipped === 'number' ? value.skipped : 0 }
}

function parseExport(value: unknown): { fileName: string; content: string } | null {
  if (!isRecord(value) || typeof value.fileName !== 'string' || typeof value.content !== 'string') return null
  return { fileName: value.fileName, content: value.content }
}

/** Save an explicit export through a transient object URL; false when unavailable. */
function downloadText(fileName: string, content: string): boolean {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return false
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  if (typeof create !== 'function' || typeof revoke !== 'function') return false
  const url = create.call(URL, new Blob([content], { type: 'application/json' }))
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    revoke.call(URL, url)
  }
  return true
}

/** Transfer card, rendered only when the provider claims the capability. */
export function TransferSection(): JSX.Element {
  const { t, provider, busy, run } = useHubUi()
  const accounts = provider.accounts ?? []
  const [exportIds, setExportIds] = useState<ReadonlySet<string>>(() => new Set(accounts.map((account) => account.id)))
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<TransferPreview | null>(null)
  const [importIds, setImportIds] = useState<ReadonlySet<string>>(new Set())
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const exporting = busy === actionBusyKey({ type: 'transfer-export', provider: provider.id })
  const previewing = busy === actionBusyKey({ type: 'transfer-preview', provider: provider.id })
  const importing = busy === actionBusyKey({ type: 'transfer-import', provider: provider.id })

  const selectedExport = accounts.filter((account) => exportIds.has(account.id))
  const allSelected = accounts.length > 0 && selectedExport.length === accounts.length

  const toggleExport = (id: string, checked: boolean): void => {
    setExportIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const toggleImport = (id: string, checked: boolean): void => {
    setImportIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const exportAccounts = async (): Promise<void> => {
    const result = await run({ type: 'transfer-export', provider: provider.id, accountIds: accounts.filter((account) => exportIds.has(account.id)).map((account) => account.id) })
    if (!result.ok) {
      setFeedback({ tone: 'error', text: result.error ?? t('actionRejected') })
      return
    }
    const payload = parseExport(result.data)
    if (payload === null) {
      setFeedback({ tone: 'error', text: t('transferInvalid') })
      return
    }
    downloadText(payload.fileName, payload.content)
    setFeedback({ tone: 'success', text: t('transferExported', { fileName: payload.fileName }) })
  }

  const requestPreview = async (): Promise<void> => {
    const result = await run({ type: 'transfer-preview', provider: provider.id, text })
    if (!result.ok) {
      setFeedback({ tone: 'error', text: result.error ?? t('actionRejected') })
      return
    }
    const parsed = parsePreview(result.data)
    if (parsed === null) {
      setPreview(null)
      setFeedback({ tone: 'error', text: t('transferInvalid') })
      return
    }
    setPreview(parsed)
    setImportIds(new Set(parsed.rows.map((row) => row.id)))
    setFeedback(null)
  }

  const importAccounts = async (): Promise<void> => {
    const result = await run({
      type: 'transfer-import',
      provider: provider.id,
      text,
      accountIds: (preview?.rows ?? []).filter((row) => importIds.has(row.id)).map((row) => row.id),
    })
    if (!result.ok) {
      setFeedback({ tone: 'error', text: result.error ?? t('actionRejected') })
      return
    }
    setFeedback({ tone: 'success', text: result.message ?? t('transferImported', { count: importIds.size }) })
    setPreview(null)
    setImportIds(new Set())
    setText('')
  }

  const cancelImport = (): void => {
    setPreview(null)
    setImportIds(new Set())
    setText('')
    setFeedback(null)
  }

  return (
    <SectionCard
      title={t('sectionTransfer')}
      icon={<IconExport size={14} />}
      meta={<Tag tone="quiet">{t('accountsTitle')} · {formatNumber(accounts.length)}</Tag>}
    >
      <div className="ch-transfer">
        <div className="ch-card-title">{t('transferExportTitle')}</div>
        <InlineNote tone="warn">{t('transferExportHint')}</InlineNote>
        <div className="ch-row">
          <span className="ch-caption">{formatNumber(selectedExport.length)} / {formatNumber(accounts.length)}</span>
          <span className="ch-spacer" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExportIds(allSelected ? new Set() : new Set(accounts.map((account) => account.id)))}
            disabled={busy !== null || accounts.length === 0}
          >
            {allSelected ? t('transferClearAll') : t('transferSelectAll')}
          </Button>
        </div>
        <div className="ch-export-list">
          {accounts.map((account) => (
            <label className="ch-export-row" key={account.id}>
              <input
                className="ch-check"
                type="checkbox"
                checked={exportIds.has(account.id)}
                onChange={(event) => toggleExport(account.id, event.target.checked)}
                aria-label={t('transferExportAria', { account: account.label })}
                disabled={busy !== null}
              />
              <span className="ch-truncate">{account.label}</span>
              {account.selected ? <Tag tone="solid">{t('accountSelectedTag')}</Tag> : null}
            </label>
          ))}
        </div>
        <div className="ch-row">
          <Button
            variant="outline"
            size="sm"
            icon={<IconExport size={14} />}
            onClick={() => { void exportAccounts() }}
            disabled={busy !== null || exportIds.size === 0}
          >
            {exporting ? t('transferExporting') : t('transferExport')}
          </Button>
          {exportIds.size === 0
            ? <span className="ch-caption">{t('transferExportNone')}</span>
            : null}
        </div>
        <div className="ch-divider" />
        <div className="ch-card-title">{t('transferImportTitle')}</div>
        <InlineNote>{t('transferImportHint')}</InlineNote>
        <textarea
          className="ch-transfer-textarea"
          value={text}
          onChange={(event) => { setText(event.target.value); setPreview(null); setImportIds(new Set()) }}
          placeholder={t('transferPlaceholder')}
          aria-label={t('transferImportTitle')}
          spellCheck={false}
        />
        <div className="ch-row">
          <Button
            variant="outline"
            size="sm"
            icon={<IconImport size={14} />}
            onClick={() => { void requestPreview() }}
            disabled={busy !== null || text.trim() === ''}
          >
            {previewing ? t('transferPreviewing') : t('transferPreview')}
          </Button>
          {preview === null
            ? null
            : (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => { void importAccounts() }}
                  disabled={busy !== null || importIds.size === 0}
                >
                  {importing ? t('transferImporting') : t('transferImport')}
                </Button>
                <Button variant="ghost" size="sm" onClick={cancelImport} disabled={busy !== null}>
                  {t('transferCancel')}
                </Button>
              </>
            )}
        </div>
        {preview === null
          ? null
          : (
            <div className="ch-preview">
              <div className="ch-preview-head">
                <span className="ch-card-title">{t('transferPreviewTitle')}</span>
                <span className="ch-caption">
                  {t('transferPreviewSummary', { count: preview.rows.length, skipped: preview.skipped })}
                </span>
              </div>
              {preview.rows.length === 0
                ? <InlineNote tone="warn">{t('transferInvalid')}</InlineNote>
                : preview.rows.map((row) => (
                  <label className="ch-preview-row" key={row.id}>
                    <input
                      className="ch-check"
                      type="checkbox"
                      checked={importIds.has(row.id)}
                      onChange={(event) => toggleImport(row.id, event.target.checked)}
                      aria-label={t('transferImportAccountAria', { account: row.label })}
                      disabled={busy !== null}
                    />
                    <span className="ch-preview-label">
                      <span className="ch-truncate">{row.label}</span>
                      <span className="ch-preview-id ch-truncate">{row.id}</span>
                    </span>
                    <Tag tone={row.region === 'cn' ? 'neutral' : row.region === 'global' ? 'info' : 'quiet'}>
                      {row.region === 'cn' ? t('regionCn') : row.region === 'global' ? t('regionGlobal') : t('transferRegionUnknown')}
                    </Tag>
                    <Tag tone={row.hasToken ? 'warning' : 'quiet'}>
                      {row.hasToken ? t('transferHasToken') : t('transferNoToken')}
                    </Tag>
                  </label>
                ))}
            </div>
          )}
        {feedback === null ? null : <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>}
      </div>
    </SectionCard>
  )
}
