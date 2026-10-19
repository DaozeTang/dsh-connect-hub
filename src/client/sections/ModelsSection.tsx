/** Model catalog section: search, per-model toggles, bulk actions, max context. */

import { useState } from 'react'
import { Button, Input, Switch, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HubModel } from '../../shared/contracts.ts'
import {
  actionBusyKey,
  allModelIds,
  filterModels,
  formatMultiplier,
  formatTokenWindow,
  localizedServerLabel,
  modelCounts,
} from '../format.ts'
import { IconModels, IconSearch, IconRefresh } from '../icons.tsx'
import { EmptyState, InlineNote, SectionCard, relativeTimeText } from '../ui.tsx'
import { useHubUi, mapProvider } from '../ui-context.ts'

const CATALOG_SOURCE_KEY = {
  live: 'catalogLive',
  saved: 'catalogSaved',
  builtin: 'catalogBuiltin',
} as const

const CATALOG_SOURCE_TONE = {
  live: 'success',
  saved: 'neutral',
  builtin: 'quiet',
} as const

/** The model list for the shown region. Models are the primary control here. */
export function ModelsSection(): JSX.Element {
  const { t, provider, busy, now, run, runOptimistic } = useHubUi()
  const [query, setQuery] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const models = provider.catalog.models
  const counts = modelCounts(models)
  const filtered = filterModels(models, query)
  const refreshKey = actionBusyKey({ type: 'refresh-catalog', provider: provider.id })
  const refreshing = busy === refreshKey
  // Only rows that advertise a larger tier carry `useMaxContext`; an `every`
  // check would read a mixed catalog as "off" right after the user enabled it.
  const maxContextOn = models.some((model) => model.useMaxContext)
  // A max-context switch only means something when the catalog actually
  // advertises a window beyond the default one. WorkBuddy CN never has one and
  // its host action rejects the call, so it stays hidden there regardless.
  const hasMaxTier = models.some((model) => model.useMaxContext || model.maxContextWindow > model.contextWindow)
  const showMaxContext = hasMaxTier && !(provider.family === 'workbuddy' && provider.region === 'cn')

  const notify = (result: { ok: boolean; error?: string | undefined; message?: string | undefined }): void => {
    if (result.ok) {
      if (result.message !== undefined) setFeedback({ tone: 'success', text: result.message })
      return
    }
    setFeedback({ tone: 'error', text: result.error ?? t('actionRejected') })
  }

  const toggleModel = (model: HubModel, next: boolean): void => {
    void runOptimistic(
      { type: 'set-model-enabled', provider: provider.id, modelId: model.id, enabled: next },
      (status) => mapProvider(status, provider.id, (current) => ({
        ...current,
        catalog: {
          ...current.catalog,
          models: current.catalog.models.map((item) => (item.id === model.id ? { ...item, enabled: next } : item)),
        },
      })),
    ).then(notify)
  }

  const bulk = (next: boolean): void => {
    if (models.length === 0) return
    void runOptimistic(
      { type: 'set-models-enabled', provider: provider.id, modelIds: allModelIds(models), enabled: next },
      (status) => mapProvider(status, provider.id, (current) => ({
        ...current,
        catalog: {
          ...current.catalog,
          models: current.catalog.models.map((item) => ({ ...item, enabled: next })),
        },
      })),
    ).then(notify)
  }

  const setMaxContext = (next: boolean): void => {
    void runOptimistic(
      { type: 'set-max-context', provider: provider.id, useMax: next },
      (status) => mapProvider(status, provider.id, (current) => ({
        ...current,
        catalog: {
          ...current.catalog,
          models: current.catalog.models.map((item) => ({ ...item, useMaxContext: next })),
        },
      })),
    ).then(notify)
  }

  const refresh = async (): Promise<void> => {
    const result = await run({ type: 'refresh-catalog', provider: provider.id })
    notify(result)
  }

  const meta = (
    <>
      <Tag tone={CATALOG_SOURCE_TONE[provider.catalog.source]}>{t(CATALOG_SOURCE_KEY[provider.catalog.source])}</Tag>
      <span className="ch-caption">
        {provider.catalog.updatedAt === undefined
          ? t('neverUpdated')
          : t('catalogUpdated', { time: relativeTimeText(t, provider.catalog.updatedAt, now) })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconRefresh size={14} />}
        onClick={() => { void refresh() }}
        disabled={busy !== null}
      >
        {refreshing ? t('refreshing') : t('refreshCatalog')}
      </Button>
    </>
  )

  return (
    <SectionCard title={t('sectionModels')} icon={<IconModels size={14} />} meta={meta}>
      <div className="ch-model-toolbar">
        <Input
          className="ch-model-search"
          icon={<IconSearch size={14} />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('modelsSearchPlaceholder')}
          aria-label={t('modelsSearchAria')}
          type="search"
        />
        <span className="ch-caption ch-tabular">{t('modelsCount', { enabled: counts.enabled, total: counts.total })}</span>
        <span className="ch-spacer" />
        <div className="ch-model-toggles">
          <Button variant="ghost" size="sm" onClick={() => bulk(true)} disabled={busy !== null || models.length === 0 || counts.enabled === counts.total}>
            {t('enableAll')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => bulk(false)} disabled={busy !== null || models.length === 0 || counts.enabled === 0}>
            {t('disableAll')}
          </Button>
        </div>
      </div>
      {showMaxContext
        ? (
          <div className="ch-model-secondary">
            <span className="ch-caption">{t('maxContextHint')}</span>
            <div className="ch-max-context">
              <span className="ch-max-context-title">{t('maxContext')}</span>
              <Switch
                checked={maxContextOn}
                label={t('maxContext')}
                onChange={setMaxContext}
                disabled={busy !== null}
                title={t('maxContextHint')}
              />
            </div>
          </div>
        )
        : null}
      {provider.catalog.error === undefined
        ? null
        : <InlineNote tone="warn">{t('catalogError', { message: provider.catalog.error })}</InlineNote>}
      {models.length === 0
        ? <EmptyState title={t('catalogEmpty')} />
        : filtered.length === 0
          ? <EmptyState title={t('modelsNoResults', { query })} />
          : (
            <div className="ch-model-list" role="list">
              {filtered.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  disabled={busy !== null}
                  onToggle={(next) => toggleModel(model, next)}
                />
              ))}
            </div>
          )}
      {feedback === null ? null : <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>}
    </SectionCard>
  )
}

function ModelRow({ model, disabled, onToggle }: {
  model: HubModel
  disabled: boolean
  onToggle: (next: boolean) => void
}): JSX.Element {
  const { t } = useHubUi()
  const context = model.useMaxContext ? model.maxContextWindow : model.contextWindow
  return (
    <div className="ch-model" data-enabled={model.enabled} role="listitem">
      <Switch
        checked={model.enabled}
        label={t('modelEnableAria', { model: model.name })}
        onChange={onToggle}
        disabled={disabled}
      />
      <div className="ch-model-main">
        <div className="ch-model-name">
          <span className="ch-truncate">{model.name}</span>
          {model.badges.map((badge) => <Tag key={badge} tone="outline">{localizedServerLabel(t, badge)}</Tag>)}
        </div>
        <div className="ch-model-id ch-truncate">{model.id}</div>
      </div>
      <div className="ch-model-badges">
        {model.inputs.includes('image')
          ? <Tooltip label={t('imageChipHint')}><span><Tag tone="info">{t('imageChip')}</Tag></span></Tooltip>
          : null}
        {model.reasoning === null
          ? null
          : (
            <Tooltip label={t('reasoningLevels', { levels: model.reasoning.supported.join(' / ') })}>
              <span><Tag tone="neutral">{t('reasoningChip')}</Tag></span>
            </Tooltip>
          )}
      </div>
      <div className="ch-model-side">
        <Tooltip label={model.multiplier === undefined ? t('priceUnknownHint') : t('multiplierHint')}>
          <div className="ch-model-price" data-unknown={model.multiplier === undefined}>
            <span className="ch-model-price-value">
              {model.multiplier === undefined ? t('priceUnknown') : formatMultiplier(model.multiplier)}
            </span>
          </div>
        </Tooltip>
        <Tooltip label={t('modelContextHint', { window: formatTokenWindow(model.contextWindow), max: formatTokenWindow(model.maxContextWindow) })}>
          <span className="ch-caption ch-tabular">{formatTokenWindow(context)}</span>
        </Tooltip>
      </div>
    </div>
  )
}
