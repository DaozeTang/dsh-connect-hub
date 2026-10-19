import { describe, expect, it } from 'vitest'
import {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
} from '../../../src/providers/workbuddy/catalog.ts'
import {
  modelWithCurrentPromotion,
  normalizeCredits,
  parseModelCatalog,
  type WorkBuddyUpstreamModel,
} from '../../../src/providers/workbuddy/upstream.ts'

/**
 * The CN roster comes from the `/v3/config` product document, and the roster
 * churns day to day, so the static fallback is only a boot-time placeholder.
 * This suite pins the mechanism (roster ∩ usable rows, badges merged from the
 * console document) and pins the fallback table to the same parse, so the two
 * cannot drift apart silently.
 */

/** Raw `/v3/config` rows the CN fallback table was transcribed from. */
const LIVE_ROWS: readonly Record<string, unknown>[] = [
  { id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 960_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['high'] }, credits: 'x0.29 credits' },
  { id: 'hy3', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.00 credits' },
  { id: 'hy3-x', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.05 credits' },
  { id: 'step-5-preview', name: 'Step-5-Preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'medium', 'high'] }, credits: 'x0.00 credits' },
  { id: 'space-bunny', name: 'Space-Bunny', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'max', summary: 'auto', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, credits: 'x0.08 credits' },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] }, credits: 'x0.11 credits' },
  { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'max', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] }, credits: 'x0.79 credits' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', maxInputTokens: 1_000_000, maxOutputTokens: 131_072, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] }, credits: 'x0.06 credits' },
  { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', maxInputTokens: 1_000_000, maxOutputTokens: 131_072, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] }, credits: 'x0.14 credits' },
  { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: false, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.79 credits' },
  { id: 'glm-5.1', name: 'GLM-5.1', maxInputTokens: 200_000, maxOutputTokens: 48_000, supportsImages: false, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.79 credits' },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', maxInputTokens: 200_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.71 credits' },
  { id: 'minimax-m3-pay', name: 'MiniMax-M3', maxInputTokens: 512_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.25 credits' },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', maxInputTokens: 200_000, maxOutputTokens: 48_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.26 credits' },
  { id: 'kimi-k3-2', name: 'Kimi-K3', maxInputTokens: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x1.62' },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] }, credits: 'x0.77 credits' },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', maxInputTokens: 256_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.57 credits' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', maxInputTokens: 256_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.52 credits' },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.51 credits' },
]
const LIVE_ROSTER = LIVE_ROWS.map((row) => String(row['id']))
const CONSOLE_BADGES = new Map<string, readonly string[]>([
  ['hy4-preview', ['badge:夜间免费:#FF0000']],
  ['hy3', ['badge:限时免费:#FF0000']],
  ['step-5-preview', ['badge:独家限免:#FF0000']],
  ['glm-5.2', ['badge:夜间折扣:#1E90FF']],
])

describe('CN catalog parsing', () => {
  it('membership is the cli roster intersected with usable rows', () => {
    const document = {
      models: [
        ...LIVE_ROWS,
        { id: 'minimax-m2.5', name: 'MiniMax-M2.5', maxInputTokens: 200_000, maxOutputTokens: 48_000, disabled: true, supportsReasoning: true, onlyReasoning: true },
        { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', maxInputTokens: 0, maxOutputTokens: 0 },
      ],
      agents: [{ name: 'cli', models: [...LIVE_ROSTER, 'kimi-k2.5'] }],
    }
    const models = parseModelCatalog(document, false, CONSOLE_BADGES)
    expect(models.map((model) => model.id)).toEqual(LIVE_ROSTER)
  })

  it('merges the console document badge tags without trusting it for anything else', () => {
    const document = { models: LIVE_ROWS.filter((row) => row['id'] === 'hy3'), agents: [{ name: 'cli', models: ['hy3'] }] }
    const models = parseModelCatalog(document, false, CONSOLE_BADGES)
    expect(models[0]?.billing).toEqual({ credits: 'x0.00 credits', badges: ['限时免费'], free: true })
  })

  it('the static fallback equals the live parse of the day it was captured', () => {
    const document = { models: LIVE_ROWS, agents: [{ name: 'cli', models: LIVE_ROSTER }] }
    const parsed = parseModelCatalog(document, false, CONSOLE_BADGES)
    const stable = parsed.map((model) => {
      const { badges: _badges, ...billing } = model.billing ?? {}
      return { ...model, billing }
    })
    expect(stable).toEqual(FALLBACK_WORKBUDDY_MODELS)
    expect(FALLBACK_WORKBUDDY_MODELS.every((model) => model.billing?.badges === undefined)).toBe(true)
    expect(parsed.filter((model) => model.billing?.badges !== undefined).map((model) => model.id).sort()).toEqual([
      'glm-5.2',
      'hy3',
      'hy4-preview',
      'step-5-preview',
    ])
  })

  it('renames a duplicated display name after the id tail, leaving ids alone', () => {
    const document = { models: LIVE_ROWS, agents: [{ name: 'cli', models: LIVE_ROSTER }] }
    const models = parseModelCatalog(document, false, CONSOLE_BADGES)
    expect(models.map((model) => model.id)).toEqual(LIVE_ROSTER)
    const names = models.map((model) => model.name)
    expect(new Set(names).size).toBe(names.length)
    expect(models.find((model) => model.id === 'hy3')?.name).toBe('Hy3')
    expect(models.find((model) => model.id === 'hy3-x')?.name).toBe('Hy3-X')
    expect(models.find((model) => model.id === 'kimi-k3-2')?.name).toBe('Kimi-K3')
  })

  it('rejects a document with no cli roster rather than serving a partial list', () => {
    expect(() => parseModelCatalog({ models: [], agents: [] }, true)).toThrow(/cli agent/)
    expect(() => parseModelCatalog({ productFeatures: {} }, true)).toThrow(/cli agent/)
    expect(() => parseModelCatalog({ models: [], agents: [{ name: 'cli', models: [] }] }, true)).toThrow(/cli agent/)
  })
})

describe('international catalog parsing', () => {
  const document = {
    models: [
      { id: 'hy3', name: 'Hy3', maxInputTokens: 1000, maxOutputTokens: 100, credits: 'x0.00', supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' } },
      { id: 'ctx-model', name: 'Ctx', maxInputTokens: 1_000_000, maxOutputTokens: 100, credits: 'x1.00', contextWindow: { defaultLength: 300_000, supportedLengths: [300_000, 1_000_000] } },
      { id: 'not-in-cli', name: 'Excluded', maxInputTokens: 1000, maxOutputTokens: 100 },
    ],
    agents: [{ name: 'cli', models: ['hy3', 'ctx-model'] }],
  }

  it('follows the cli roster order and uses the declared default window', () => {
    const models = parseModelCatalog(document, true)
    expect(models.map((model) => model.id)).toEqual(['hy3', 'ctx-model'])
    const ctx = models[1]!
    expect(ctx.contextWindow).toBe(300_000)
    expect(ctx.defaultContextWindow).toBe(300_000)
    expect(ctx.maxInputTokens).toBe(1_000_000)
    expect(ctx.supportedContextWindows).toEqual([300_000, 1_000_000])
  })

  it('does not attach international fields to the CN shape', () => {
    const [cn] = parseModelCatalog(document, false)
    expect(cn).toEqual({
      id: 'hy3',
      name: 'Hy3',
      contextWindow: 1000,
      maxTokens: 100,
      supportsImages: true,
      reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false },
      billing: { credits: 'x0.00', free: true },
    })
  })

  it('treats unknown, disabled multimodal, and absent capability fields as text-only', () => {
    const models = parseModelCatalog(
      {
        models: [
          { id: 'a', name: 'A', maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: true },
          { id: 'b', name: 'B', maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: true, disabledMultimodal: true },
          { id: 'c', name: 'C', maxInputTokens: 1000, maxOutputTokens: 100 },
        ],
        agents: [{ name: 'cli', models: ['a', 'b', 'c'] }],
      },
      false,
    )
    expect(models.map((model) => model.supportsImages)).toEqual([true, false, false])
  })
})

describe('normalizeCredits', () => {
  it('keeps a bare multiplier and strips a trailing unit word', () => {
    expect(normalizeCredits('x0.79')).toBe('x0.79')
    expect(normalizeCredits('x0.79 credits')).toBe('x0.79')
    expect(normalizeCredits('x1.62 CREDITS')).toBe('x1.62')
    expect(normalizeCredits('x0.79 credit')).toBe('x0.79')
    expect(normalizeCredits('  x0.79 credits  ')).toBe('x0.79')
  })

  it('returns undefined for absent or unit-only values', () => {
    expect(normalizeCredits(undefined)).toBeUndefined()
    expect(normalizeCredits('')).toBeUndefined()
    expect(normalizeCredits('credits')).toBeUndefined()
  })
})

describe('WorkBuddyCatalog', () => {
  it('hides every model when the route has no credential', () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    expect(catalog.current().length).toBeGreaterThan(0)
    expect(catalog.setVisible(false)).toBe(true)
    expect(catalog.current()).toEqual([])
    expect(catalog.setVisible(false)).toBe(false)
    expect(catalog.setVisible(true)).toBe(true)
    expect(catalog.current().length).toBeGreaterThan(0)
    expect(catalog.setVisible(true)).toBe(false)
  })

  it('keeps the fallback roster available behind the visibility gate', () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS)
    catalog.setVisible(false)
    expect(catalog.fallback()).toHaveLength(FALLBACK_WORKBUDDY_AI_MODELS.length)
  })

  it('gives each variant its own roster', () => {
    expect(FALLBACK_WORKBUDDY_MODELS).toHaveLength(19)
    expect(FALLBACK_WORKBUDDY_AI_MODELS).toHaveLength(20)
    const cn = FALLBACK_WORKBUDDY_MODELS.map((model) => model.id)
    const ai = FALLBACK_WORKBUDDY_AI_MODELS.map((model) => model.id)
    expect(cn).toEqual([
      'hy4-preview', 'hy3', 'hy3-x', 'step-5-preview', 'space-bunny',
      'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx',
      'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3-pay',
      'minimax-m2.7', 'kimi-k3-2', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6',
      'deepseek-v4-pro',
    ])
    expect(ai).toContain('gpt-5.6-luna')
    expect(ai).not.toContain('minimax-m3-pay')
    expect(cn).not.toContain('gpt-5.6-luna')
    expect(cn).not.toContain('hy4-preview-f')
  })

  it('can switch an international catalog to its declared maximum windows', () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS)
    expect(catalog.current().find((model) => model.id === 'deepseek-v4.1-flash')?.contextWindow).toBe(300_000)
    expect(catalog.setUseMaximumContextWindow(true)).toBe(true)
    expect(catalog.current().find((model) => model.id === 'deepseek-v4.1-flash')?.contextWindow).toBe(1_000_000)
    expect(catalog.current().find((model) => model.id === 'gpt-5.6-sol')?.contextWindow).toBe(1_000_000)
    expect(catalog.setUseMaximumContextWindow(true)).toBe(false)
  })

  it('bakes no promo badge into the international fallback', () => {
    for (const model of FALLBACK_WORKBUDDY_AI_MODELS) {
      expect(model.billing?.badges, `${model.id} must not carry a baked-in badge`).toBeUndefined()
    }
  })
})

describe('promotion lifetime', () => {
  const base = {
    id: 'hy3',
    name: 'Hy3',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    billing: { credits: 'x0.50', free: false },
    promotions: [
      {
        start: Date.parse('2026-07-06T00:00:00+08:00'),
        end: Date.parse('2026-09-30T00:00:00+08:00'),
        label: 'Free now',
        factor: 0,
        priority: 200,
      },
    ],
  }

  it('applies an active promotion', () => {
    const model = modelWithCurrentPromotion(base, Date.parse('2026-08-01T00:00:00+08:00'))
    expect(model.billing).toEqual({ credits: 'x0.00', free: true, badges: ['Free now'] })
  })

  it('withholds the rate once the window has closed or has not opened', () => {
    for (const now of [Date.parse('2026-10-01T00:00:00+08:00'), Date.parse('2026-01-01T00:00:00+08:00')]) {
      const model = modelWithCurrentPromotion(base, now)
      expect(model.billing).toEqual({ free: false, rateUnknown: true })
      expect(model.billing?.credits).toBeUndefined()
      expect(model.billing?.badges).toBeUndefined()
    }
  })

  it('still states a rate for a row that never had a promotion', () => {
    const plain: WorkBuddyUpstreamModel = {
      id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000, maxTokens: 100,
      supportsImages: true, billing: { credits: 'x0.79', free: false },
    }
    expect(modelWithCurrentPromotion(plain, Date.parse('2026-10-01T00:00:00+08:00'))).toBe(plain)
  })

  it('scales a non-zero discount factor and skips an unparseable base rate', () => {
    const scaled = modelWithCurrentPromotion(
      { ...base, promotions: [{ ...base.promotions[0]!, factor: 0.5, label: 'Half off' }] },
      Date.parse('2026-08-01T00:00:00+08:00'),
    )
    expect(scaled.billing?.credits).toBe('x0.25')
    const auto: WorkBuddyUpstreamModel = {
      id: 'default-model', name: 'Auto', contextWindow: 1, maxTokens: 1,
      supportsImages: false, billing: { credits: '', free: false },
      promotions: [{ ...base.promotions[0]!, factor: 2 }],
    }
    expect(modelWithCurrentPromotion(auto, Date.parse('2026-08-01T00:00:00+08:00'))).toBe(auto)
  })
})
