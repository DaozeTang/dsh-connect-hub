import { describe, expect, it } from 'vitest'
import type { TraeModelInfo } from '../../../src/providers/trae/catalog.ts'
import {
  effectiveContextWindows,
  hubModelOf,
  imageCapable,
  servedModelsOf,
  withImageCapability,
} from '../../../src/providers/trae/model-selection.ts'
import { defaultTraePrefs } from '../../../src/providers/trae/prefs.ts'

const catalog: TraeModelInfo[] = [
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    contextWindow: 200_000,
    maxContextWindow: 1_000_000,
    creditMultiplier: 0.08,
    multimodal: true,
    reasoningSupported: true,
    reasoning: { supported: ['low', 'high'], defaultEffort: 'high' },
  },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 200_000, multimodal: false },
  { id: 'unsized-model', name: 'Unsized' },
]

describe('image capability', () => {
  it('follows Trae\u2019s own multimodal flag', () => {
    expect(imageCapable({ multimodal: true })).toBe(true)
    expect(imageCapable({ multimodal: false })).toBe(false)
    expect(imageCapable({})).toBe(false)
  })

  it('re-derives every row\u2019s modalities instead of trusting a saved value', () => {
    const stale = catalog.map(model => ({ ...model, input: ['text', 'image'] as ('text' | 'image')[] }))
    expect(withImageCapability(stale).map(model => model.input?.join(',')).slice(0, 2)).toEqual(['text,image', 'text'])
  })
})

describe('context windows', () => {
  it('switches to the advertised Max window only when the user asked for it', () => {
    expect(effectiveContextWindows({ contextWindow: 200_000, maxContextWindow: 1_000_000 }, false)).toEqual({
      contextWindow: 200_000,
      maxContextWindow: 1_000_000,
      useMaxContext: false,
    })
    expect(effectiveContextWindows({ contextWindow: 200_000, maxContextWindow: 1_000_000 }, true)).toEqual({
      contextWindow: 1_000_000,
      maxContextWindow: 1_000_000,
      useMaxContext: true,
    })
  })

  it('never fabricates a window for a model that does not advertise one', () => {
    expect(effectiveContextWindows({}, true)).toEqual({
      contextWindow: 200_000,
      maxContextWindow: 200_000,
      useMaxContext: false,
    })
  })
})

describe('hub model projection', () => {
  it('exposes visibility, multiplier and reasoning with the region-wide max-context preference', () => {
    const prefs = defaultTraePrefs()
    prefs.useMaxContext = true
    prefs.modelEnabled['deepseek-v4-pro'] = false
    const glm = hubModelOf(catalog[0]!, prefs)
    expect(glm).toMatchObject({
      id: 'glm-5.2',
      enabled: true,
      multiplier: 0.08,
      contextWindow: 1_000_000,
      maxContextWindow: 1_000_000,
      useMaxContext: true,
      inputs: ['text', 'image'],
      badges: [],
      reasoning: { supported: ['low', 'high'], default: 'high', canDisable: false },
    })
    const deepseek = hubModelOf(catalog[1]!, prefs)
    expect(deepseek.enabled).toBe(false)
    expect(deepseek.badges).toEqual([])
    expect(deepseek).not.toHaveProperty('multiplier')
  })
})

describe('served models', () => {
  it('serves enabled rows, and falls back to the region list when every model is disabled', () => {
    const prefs = defaultTraePrefs()
    const served = servedModelsOf(catalog, prefs, 'cn')
    expect(served.map(model => model.id)).toEqual(['glm-5.2', 'deepseek-v4-pro', 'unsized-model'])
    expect(served.every(model => Number.isInteger(model.contextWindow))).toBe(true)

    prefs.modelEnabled['glm-5.2'] = false
    prefs.modelEnabled['deepseek-v4-pro'] = false
    prefs.modelEnabled['unsized-model'] = false
    const fallback = servedModelsOf(catalog, prefs, 'cn')
    expect(fallback.map(model => model.id)).toContain('DeepSeek-V4-Flash-Official')
    expect(fallback.every(model => (model.contextWindow ?? 0) > 0)).toBe(true)
  })

  it('keeps wire resolution metadata on the served rows', () => {
    const served = servedModelsOf([{
      id: 'Seed-Code',
      name: 'Seed-Code',
      contextWindow: 200_000,
      wireConfigName: 'seed-code-config',
      wireFunction: 'chat_v3',
    }], defaultTraePrefs(), 'cn')
    expect(served[0]).toMatchObject({ wireConfigName: 'seed-code-config', wireFunction: 'chat_v3' })
  })
})
