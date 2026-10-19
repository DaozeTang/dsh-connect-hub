import { describe, expect, it } from 'vitest'
import {
  FALLBACK_TRAE_MODELS,
  FALLBACK_TRAE_MODELS_AI,
  fallbackModelsFor,
  mergeTraeModelSources,
  TraeCatalog,
  traeInputModalities,
} from '../../../src/providers/trae/catalog.ts'
import { parseTraeRemoteModel } from '../../../src/providers/trae/model-metadata.ts'

function remote(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: 'qwen3.8-max',
    display_name: 'Qwen3.8-Max',
    multimodal: true,
    max_mode: true,
    context_window_tokens: { dev: 200_000, max: 1_000_000 },
    features: JSON.stringify({
      reasoning: { enable: true },
      consumption_rate: { enable: true, data: { rate: 0.08 } },
    }),
    reasoning_effort_config: { options: ['light', 'high', 'extra_high'], default_level: 'high' },
    ...overrides,
  }
}

describe('Trae fallback catalogs', () => {
  it('starts each region with sized, text-only fallback entries', () => {
    const cn = fallbackModelsFor('cn')
    const ai = fallbackModelsFor('ai')
    expect(cn).toEqual(FALLBACK_TRAE_MODELS)
    expect(ai).toEqual(FALLBACK_TRAE_MODELS_AI)
    for (const model of [...cn, ...ai]) {
      expect(Number.isInteger(model.contextWindow)).toBe(true)
      expect(model.contextWindow ?? 0).toBeGreaterThan(0)
      expect(model.input ?? ['text']).toEqual(['text'])
    }
    expect(traeInputModalities(cn[0]!)).toEqual(['text'])
    // Region isolation: the international roster never appears in the CN fallback.
    expect(cn.map(model => model.id)).not.toContain('gemini-3.1-pro')
    expect(ai.map(model => model.id)).not.toContain('glm-5.2')
  })
})

describe('parseTraeRemoteModel', () => {
  it('parses only advertised capabilities, including the post-discount multiplier and Max tier', () => {
    expect(parseTraeRemoteModel(remote())).toEqual({
      id: 'qwen3.8-max',
      name: 'Qwen3.8-Max',
      multimodal: true,
      contextWindow: 200_000,
      maxContextWindow: 1_000_000,
      creditMultiplier: 0.08,
      reasoningSupported: true,
      reasoning: { supported: ['low', 'high', 'xhigh'], defaultEffort: 'high' },
    })
  })

  it('omits facts the upstream did not send instead of inventing them', () => {
    const parsed = parseTraeRemoteModel(remote({
      multimodal: false,
      max_mode: false,
      context_window_tokens: {},
      features: undefined,
      reasoning_effort_config: undefined,
    }))
    expect(parsed).toEqual({
      id: 'qwen3.8-max',
      name: 'Qwen3.8-Max',
      multimodal: false,
      reasoningSupported: false,
    })
  })

  it('rejects rows without a usable name', () => {
    expect(parseTraeRemoteModel({ display_name: 'x' })).toBeUndefined()
    expect(parseTraeRemoteModel({ name: '' })).toBeUndefined()
    expect(parseTraeRemoteModel(null)).toBeUndefined()
  })
})

describe('mergeTraeModelSources', () => {
  it('joins wire config names onto the remote skeleton and keeps unmatched rows', () => {
    const merged = mergeTraeModelSources(
      [{ id: 'Seed-Code', name: 'Seed-Code', multimodal: true, contextWindow: 200_000, reasoningSupported: false }],
      [{ id: 'seed-code-config', name: 'Seed-Code', contextWindow: 200_000, creditMultiplier: 0.1, function: 'chat_v3' }],
    )
    expect(merged).toEqual([
      expect.objectContaining({
        id: 'Seed-Code',
        name: 'Seed-Code',
        wireConfigName: 'seed-code-config',
        wireFunction: 'chat_v3',
        creditMultiplier: 0.1,
        input: ['text'],
        multimodal: true,
      }),
    ])
    const unmatched = mergeTraeModelSources(
      [{ id: 'unknown-model', name: 'Unknown', multimodal: false, reasoningSupported: false }],
      [],
    )
    expect(unmatched).toHaveLength(1)
    expect(unmatched[0]?.wireConfigName).toBeUndefined()
  })

  it('prefers the wire credit rate over the remote directory figure', () => {
    const merged = mergeTraeModelSources(
      [{ id: 'glm-5.2', name: 'GLM-5.2', multimodal: false, creditMultiplier: 0.8, reasoningSupported: false }],
      [{ id: 'glm-5.2', name: 'GLM-5.2', creditMultiplier: 0.08 }],
    )
    expect(merged[0]?.creditMultiplier).toBe(0.08)
  })
})

describe('TraeCatalog', () => {
  it('refuses an empty catalog and copies rows on set', () => {
    const catalog = new TraeCatalog('cn')
    expect(catalog.current()).toEqual(FALLBACK_TRAE_MODELS)
    expect(() => catalog.set([])).toThrow(/empty/)
    const row = { id: 'x', name: 'X', input: ['text'] as ('text' | 'image')[] }
    catalog.set([row])
    expect(catalog.current()).toEqual([row])
    expect(catalog.current()).not.toBe([row])
  })

  it('serves nothing while hidden but keeps the rows for a later sign-in', () => {
    const catalog = new TraeCatalog('cn')
    expect(catalog.setVisible(false)).toBe(true)
    expect(catalog.current()).toEqual([])
    expect(catalog.setVisible(false)).toBe(false)
    expect(catalog.setVisible(true)).toBe(true)
    expect(catalog.current()).toEqual(FALLBACK_TRAE_MODELS)
  })
})
