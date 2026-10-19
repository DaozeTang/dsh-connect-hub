import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HubPaths } from '../../../src/core/paths.ts'
import { FALLBACK_QODER_MODELS, QoderCatalog } from '../../../src/providers/qoder/catalog.ts'
import { normalizeQoderModels } from '../../../src/providers/qoder/qoder/catalog.ts'
import { modelInfoOf } from '../../../src/providers/qoder/upstream.ts'
import { hubModelOf, hubModelsOf } from '../../../src/providers/qoder/status.ts'
import { QoderCatalogStore } from '../../../src/providers/qoder/catalog-store.ts'
import type { QoderRegion } from '../../../src/providers/qoder/qoder/region.ts'
import { testLogger } from './fakes.ts'

const MODEL_LIST = {
  assistant: [
    {
      key: 'cmodel',
      display_name: 'Cantus (Qoder)',
      enable: true,
      max_input_tokens: 1_000_000,
      max_output_tokens: 32_768,
      is_vl: true,
      price_factor: 0.3,
      source: 'system',
      thinking_config: {
        enabled: {
          is_default: true,
          efforts: { low: {}, medium: { is_default: true }, high: {} },
        },
      },
    },
    { key: 'disabled-model', enable: false, max_input_tokens: 1_000 },
    { key: 'lite', enable: true, max_output_tokens: 16_384 },
    { key: 'cmodel', enable: true, display_name: 'duplicate entry' },
  ],
}

describe('normalizeQoderModels', () => {
  it('normalizes the upstream discovery payload', () => {
    const models = normalizeQoderModels(MODEL_LIST)
    expect(models.map(model => model.id)).toEqual(['cmodel', 'lite'])

    const cmodel = models[0]!
    expect(cmodel).toMatchObject({
      name: 'Cantus (Qoder)',
      contextWindow: 1_000_000,
      maxContextWindow: 1_000_000,
      maxTokens: 32_768,
      supportsImages: true,
      isReasoning: true,
      supportsEffort: true,
      defaultReasoningEffort: 'medium',
      priceFactor: 0.3,
      source: 'system',
    })
    expect(cmodel.reasoningEfforts?.map(effort => effort.id)).toEqual(['low', 'medium', 'high'])

    const lite = models[1]!
    expect(lite.name).toBe('lite')
    expect(lite.contextWindow).toBe(180_000)
    expect(lite.maxContextWindow).toBe(180_000)
    expect(lite.maxTokens).toBe(16_384)
    expect(lite.supportsImages).toBe(false)
    expect(lite.isReasoning).toBe(false)
    expect(lite.priceFactor).toBeUndefined()
  })

  it('selects a single default context option and keeps the largest capacity', () => {
    const models = normalizeQoderModels({
      assistant: [{
        key: 'windowed',
        enable: true,
        max_input_tokens: 150_000,
        context_config: {
          '128k': { token_count: 131_072, is_default: true },
          '200k': { token_count: 200_000 },
        },
      }],
    })
    expect(models[0]).toMatchObject({
      contextWindow: 131_072,
      maxContextWindow: 200_000,
    })
  })

  it('reports conflicting context defaults and falls back to max input', () => {
    const conflicts: string[] = []
    const models = normalizeQoderModels({
      assistant: [{
        key: 'ambiguous',
        enable: true,
        max_input_tokens: 90_000,
        context_config: {
          a: { token_count: 100_000, is_default: true },
          b: { token_count: 200_000, is_default: true },
        },
      }],
    }, conflict => conflicts.push(conflict))
    expect(conflicts).toEqual(['context-defaults'])
    expect(models[0]?.contextWindow).toBe(90_000)
    expect(models[0]?.maxContextWindow).toBe(200_000)
  })

  it('returns an empty list for malformed payloads', () => {
    expect(normalizeQoderModels(undefined)).toEqual([])
    expect(normalizeQoderModels({})).toEqual([])
    expect(normalizeQoderModels({ assistant: [{ enable: true }] })).toEqual([])
    expect(normalizeQoderModels({ assistant: [{ key: '', enable: true }] })).toEqual([])
  })
})

describe('modelInfoOf', () => {
  it('maps upstream rows onto the plugin model vocabulary', () => {
    const [cmodel] = normalizeQoderModels(MODEL_LIST)
    const info = modelInfoOf(cmodel!)
    expect(info).toMatchObject({
      id: 'cmodel',
      name: 'Cantus (Qoder)',
      contextWindow: 1_000_000,
      maxTokens: 32_768,
      supportsImages: true,
      billing: { credits: 'x0.3', free: false },
      reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium', canDisableThinking: false },
    })
  })

  it('carries the declared context options and keeps free/unknown rates honest', () => {
    const [row] = normalizeQoderModels({
      assistant: [
        {
          key: 'windowed',
          enable: true,
          context_config: {
            '128k': { token_count: 131_072, is_default: true },
            '200k': { token_count: 200_000 },
          },
        },
        { key: 'free-model', enable: true, price_factor: 0 },
        { key: 'unknown-rate', enable: true },
      ],
    })
    expect(row).toBeDefined()
    const windowed = modelInfoOf(row!)
    expect(windowed.defaultContextWindow).toBe(131_072)
    expect(windowed.supportedContextWindows).toEqual([131_072, 200_000])

    const models = normalizeQoderModels({
      assistant: [
        { key: 'free-model', enable: true, price_factor: 0 },
        { key: 'unknown-rate', enable: true },
      ],
    })
    expect(modelInfoOf(models[0]!).billing).toEqual({ credits: 'x0', free: true })
    expect(modelInfoOf(models[1]!).billing).toEqual({ free: false, rateUnknown: true })
  })
})

describe('QoderCatalog context-window selection', () => {
  const windowed = modelInfoOf(normalizeQoderModels({
    assistant: [{
      key: 'windowed',
      enable: true,
      context_config: {
        '128k': { token_count: 131_072, is_default: true },
        '200k': { token_count: 200_000 },
      },
    }],
  })[0]!)

  it('serves the default window until the maximum-context preference is on', () => {
    const catalog = new QoderCatalog([windowed])
    expect(catalog.current()[0]).toMatchObject({ contextWindow: 131_072 })
    expect(catalog.setUseMaximumContextWindow(true)).toBe(true)
    expect(catalog.current()[0]).toMatchObject({ contextWindow: 200_000, defaultContextWindow: 131_072 })
    expect(catalog.setUseMaximumContextWindow(false)).toBe(true)
    expect(catalog.current()[0]).toMatchObject({ contextWindow: 131_072 })
  })

  it('filters disabled models out of current() but keeps them in all()', () => {
    const catalog = new QoderCatalog([windowed, ...FALLBACK_QODER_MODELS])
    expect(catalog.setDisabledModels(['windowed'])).toBe(true)
    expect(catalog.current().some(model => model.id === 'windowed')).toBe(false)
    expect(catalog.all().length).toBe(FALLBACK_QODER_MODELS.length + 1)
    expect(catalog.getDisabledModels()).toEqual(['windowed'])
  })

  it('hides the whole list while no credential is adopted', () => {
    const catalog = new QoderCatalog([windowed])
    expect(catalog.setVisible(false)).toBe(true)
    expect(catalog.current()).toEqual([])
    expect(catalog.all()).toEqual([])
    expect(catalog.setVisible(true)).toBe(true)
    expect(catalog.current()).toHaveLength(1)
  })
})

describe('hub model visibility', () => {
  const models = normalizeQoderModels(MODEL_LIST).map(modelInfoOf)
  const catalog = new QoderCatalog(models)

  it('exposes every catalog model with its enabled flag and capabilities', () => {
    catalog.setDisabledModels(['lite'])
    const rows = hubModelsOf(catalog, true)
    expect(rows.map(row => row.id)).toEqual(['cmodel', 'lite'])

    const cmodel = rows[0]!
    expect(cmodel).toMatchObject({
      name: 'Cantus (Qoder)',
      enabled: true,
      multiplier: 0.3,
      badges: [],
      contextWindow: 1_000_000,
      maxContextWindow: 1_000_000,
      useMaxContext: true,
      inputs: ['text', 'image'],
      reasoning: { supported: ['low', 'medium', 'high'], default: 'medium', canDisable: false },
    })

    const lite = rows[1]!
    expect(lite).toMatchObject({
      enabled: false,
      contextWindow: 180_000,
      maxContextWindow: 180_000,
      useMaxContext: true,
      inputs: ['text'],
      reasoning: null,
    })
    expect(lite.multiplier).toBeUndefined()
  })

  it('reports a free model as a zero multiplier', () => {
    const free = modelInfoOf(normalizeQoderModels({ assistant: [{ key: 'free-model', enable: true, price_factor: 0 }] })[0]!)
    const row = hubModelOf(free, true, false)
    expect(row.multiplier).toBe(0)
    expect(row.useMaxContext).toBe(false)
  })

  it('serves no rows while signed out', () => {
    const hidden = new QoderCatalog(FALLBACK_QODER_MODELS)
    hidden.setVisible(false)
    expect(hubModelsOf(hidden, false)).toEqual([])
  })
})

function pathsFor(root: string): HubPaths {
  return {
    home: root,
    dataDir: join(root, 'hub'),
    stateDir: join(root, 'hub', 'state'),
  }
}

async function withStore(region: QoderRegion, run: (store: QoderCatalogStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'qoder-catalog-'))
  try {
    await mkdir(join(root, 'hub', 'state'), { recursive: true })
    const store = new QoderCatalogStore({ paths: pathsFor(root), region, log: testLogger() })
    await run(store, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('QoderCatalogStore', () => {
  it('round-trips the last catalog per account and region', async () => {
    await withStore('china', async (store, root) => {
      await store.load()
      expect(store.get('pat:abc')).toBeUndefined()
      store.set('pat:abc', { fetchedAtMs: 123, models: [...FALLBACK_QODER_MODELS] })
      await store.flush()

      const reopened = new QoderCatalogStore({ paths: pathsFor(root), region: 'china', log: testLogger() })
      await reopened.load()
      expect(reopened.get('pat:abc')?.fetchedAtMs).toBe(123)
      expect(reopened.get('pat:abc')?.models).toHaveLength(FALLBACK_QODER_MODELS.length)

      store.delete('pat:abc')
      await store.flush()
      const afterDelete = new QoderCatalogStore({ paths: pathsFor(root), region: 'china', log: testLogger() })
      await afterDelete.load()
      expect(afterDelete.get('pat:abc')).toBeUndefined()
    })
  })

  it('ignores a corrupt file instead of failing the provider', async () => {
    await withStore('global', async (store) => {
      await writeFile(store.filePath(), '{not json')
      await store.load()
      expect(store.get('pat:abc')).toBeUndefined()
    })
  })

  it('drops malformed model rows on load but keeps valid ones', async () => {
    await withStore('china', async (store) => {
      const valid = FALLBACK_QODER_MODELS[0]!
      await writeFile(store.filePath(), JSON.stringify({
        version: 1,
        entries: {
          'pat:abc': {
            account: 'pat:abc',
            fetchedAtMs: 42,
            models: [valid, { id: '', name: 'broken' }, { id: 'x', name: 'no capacity' }],
          },
        },
      }))
      await store.load()
      expect(store.get('pat:abc')?.models.map(model => model.id)).toEqual([valid.id])
    })
  })
})
