import { describe, expect, it } from 'vitest'
import { toCreditsView, creditsErrorView, parseUpstreamTime } from '../../../src/providers/workbuddy/credits.ts'
import { maxContextOf, parseMultiplier, reasoningView, toHubModel } from '../../../src/providers/workbuddy/models.ts'
import { accountDetailOf, maskAccountLabel, maskToken, visibilityAccountOf } from '../../../src/providers/workbuddy/mask.ts'
import { buildProviderStatus, buildWarnings, probeStateOf } from '../../../src/providers/workbuddy/status.ts'
import type { ProviderDescriptor } from '../../../src/core/types.ts'
import type { WorkBuddyUpstreamModel, WorkBuddyCredits } from '../../../src/providers/workbuddy/upstream.ts'

const DESCRIPTOR: ProviderDescriptor = {
  id: 'workbuddy',
  family: 'workbuddy',
  region: 'cn',
  label: { zh: 'WorkBuddy', en: 'WorkBuddy' },
}

const BASE_MODEL: WorkBuddyUpstreamModel = {
  id: 'glm-5.3',
  name: 'GLM-5.3',
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  supportsImages: true,
  reasoning: {
    supports: true,
    onlyReasoning: true,
    supportedEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    canDisableThinking: false,
  },
  billing: { credits: 'x0.79 credits', free: false },
}

describe('mask', () => {
  it('masks email and phone display names but keeps ordinary names', () => {
    expect(maskAccountLabel('alice@example.com')).toBe('a***@example.com')
    expect(maskAccountLabel('+86 138 1234 5678')).toBe('****5678')
    expect(maskAccountLabel('Alice')).toBe('Alice')
    expect(maskAccountLabel(undefined)).toBeUndefined()
  })

  it('describes tokens by a masked tail only', () => {
    expect(maskToken('secret-access-token')).toBe('****oken')
    expect(maskToken(undefined)).toBeUndefined()
  })

  it('keys visibility preferences only when a uid exists', () => {
    expect(visibilityAccountOf({ uid: 'uid-1', enterpriseId: 'ent-1' })).toBe('uid-1:ent-1')
    expect(visibilityAccountOf({ uid: 'uid-1' })).toBe('uid-1:')
    expect(visibilityAccountOf({ uid: '' })).toBeUndefined()
    expect(accountDetailOf({ uid: 'uid-1', domain: 'www.codebuddy.cn' })).toBe('uid ****id-1 · www.codebuddy.cn')
  })
})

describe('model mapping', () => {
  it('parses a multiplier from the raw credits string', () => {
    expect(parseMultiplier('x0.79 credits')).toBe(0.79)
    expect(parseMultiplier('x1.62')).toBe(1.62)
    expect(parseMultiplier(undefined)).toBeUndefined()
    expect(parseMultiplier('credits')).toBeUndefined()
  })

  it('offers the declared reasoning levels and suppresses CN off on only-reasoning models', () => {
    const reasoning = reasoningView(BASE_MODEL, undefined, 'cn')
    expect(reasoning).toEqual({ supported: ['low', 'high', 'max'], default: 'high', canDisable: false })
    const disabledOff = reasoningView({ ...BASE_MODEL, reasoning: { ...BASE_MODEL.reasoning!, canDisableThinking: true } }, undefined, 'cn')
    expect(disabledOff?.canDisable).toBe(false)
    const globalOff = reasoningView({ ...BASE_MODEL, reasoning: { ...BASE_MODEL.reasoning!, canDisableThinking: true } }, undefined, 'global')
    expect(globalOff?.canDisable).toBe(true)
  })

  it('uses a validating observation only for undeclared rows', () => {
    const undeclared: WorkBuddyUpstreamModel = {
      ...BASE_MODEL,
      reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false },
    }
    const observed = {
      fingerprint: 'fp',
      validation: 'validating' as const,
      efforts: ['low', 'high'] as const,
      probedAtMs: 1,
      pluginVersion: 'test',
      account: 'uid-1:',
    }
    expect(reasoningView(undeclared, observed, 'cn')).toEqual({ supported: ['low', 'high'], canDisable: false })
    expect(reasoningView(undeclared, { ...observed, validation: 'non-validating', efforts: [] }, 'cn')).toBeNull()
    expect(reasoningView(BASE_MODEL, observed, 'cn')?.supported).toEqual(['low', 'high', 'max'])
  })

  it('builds a hub model with visibility, context, multiplier, badges, and inputs', () => {
    const model = toHubModel({ ...BASE_MODEL, billing: { credits: 'x0.00', badges: ['限时免费'], free: true } }, {
      visible: false,
      useMaxContext: false,
      region: 'cn',
    })
    expect(model).toMatchObject({
      id: 'glm-5.3',
      enabled: false,
      multiplier: 0,
      badges: ['免费', '限时免费'],
      contextWindow: 1_000_000,
      maxContextWindow: 1_000_000,
      useMaxContext: false,
      inputs: ['text', 'image'],
    })
    expect(model.reasoning?.supported).toEqual(['low', 'high', 'max'])
  })

  it('reports the max context window and whether it is selected', () => {
    const intl: WorkBuddyUpstreamModel = {
      id: 'ctx',
      name: 'Ctx',
      contextWindow: 1_000_000,
      defaultContextWindow: 300_000,
      supportedContextWindows: [300_000, 1_000_000],
      maxTokens: 100,
      supportsImages: false,
    }
    expect(maxContextOf(intl)).toBe(1_000_000)
    const selected = toHubModel(intl, { visible: true, useMaxContext: true, region: 'global' })
    expect(selected).toMatchObject({ contextWindow: 1_000_000, maxContextWindow: 1_000_000, useMaxContext: true })
    const defaults = toHubModel({ ...intl, contextWindow: 300_000 }, {
      visible: true,
      useMaxContext: false,
      region: 'global',
    })
    expect(defaults).toMatchObject({ contextWindow: 300_000, useMaxContext: false })
  })

  it('reports no reasoning control for text-only or unobserved models', () => {
    expect(reasoningView({ ...BASE_MODEL, reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true } }, undefined, 'cn')).toBeNull()
    expect(toHubModel({ ...BASE_MODEL, supportsImages: false }, { visible: true, useMaxContext: false, region: 'cn' }).inputs).toEqual(['text'])
  })
})

describe('credits mapping', () => {
  const personal: WorkBuddyCredits = {
    total: 130,
    accounts: [
      { packageName: '基础包', remain: 100, size: 200, endTimeMs: 1_800_000_000_000 },
      { packageName: '赠送包', remain: 30, size: 50 },
    ],
    expiry: {
      within24h: { total: 100, packages: 1, earliestEndTimeMs: 1_800_000_000_000 },
      within3d: { total: 100, packages: 1 },
      within7d: { total: 100, packages: 1 },
    },
  }

  it('maps package credits with totals and expiries', () => {
    const view = toCreditsView(personal, 1_700_000_000_000)
    expect(view).toMatchObject({ kind: 'credits', remaining: 130, total: 250, updatedAt: 1_700_000_000_000 })
    expect(view.packages).toEqual([
      { id: '基础包:0', name: '基础包', remaining: 100, total: 200, expiresAt: 1_800_000_000_000 },
      { id: '赠送包:1', name: '赠送包', remaining: 30, total: 50 },
    ])
  })

  it('maps the enterprise cycle quota, including the uncapped marker', () => {
    const enterprise: WorkBuddyCredits = {
      total: 70,
      accounts: [{ packageName: 'enterprise', remain: 70, size: 100 }],
      cycleResetTime: '2026-11-01 00:00:00',
    }
    const view = toCreditsView(enterprise, 1)
    expect(view).toMatchObject({ kind: 'enterprise', remaining: 70, total: 100 })
    expect(view.resetAt).toBe(Date.parse('2026-11-01T00:00:00'))
    const unlimited = toCreditsView({ total: 0, accounts: [{ packageName: 'enterprise', remain: 0, size: 0, unlimited: true }], unlimited: true }, 1)
    expect(unlimited).toMatchObject({ kind: 'enterprise', plan: '不限额度' })
    expect(unlimited.remaining).toBeUndefined()
  })

  it('carries a fetch failure as its own view', () => {
    const view = creditsErrorView('额度端点不可用', 42)
    expect(view).toMatchObject({ kind: 'credits', error: '额度端点不可用', updatedAt: 42, packages: [] })
    expect(parseUpstreamTime('not a date')).toBeUndefined()
  })
})

describe('warnings', () => {
  const base = {
    appName: 'WorkBuddy',
    auth: { state: 'signed-in' as const, expiresAtMs: Date.now() + 60_000 },
    credentialError: undefined,
    transportError: undefined,
    catalogSource: 'live' as const,
    catalogError: undefined,
    creditsError: undefined,
    credits: undefined,
    rateUnknownCount: 0,
    now: Date.now(),
  }

  it('reports no credential as an actionable signed-out warning', () => {
    const warnings = buildWarnings({
      ...base,
      auth: { state: 'signed-out', reasonCode: 'no-credential' },
    })
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'no-credential', level: 'info', message: expect.stringContaining('WorkBuddy 桌面端登录一次') }),
    ])
  })

  it('reports a diagnosable credential failure at error level', () => {
    const warnings = buildWarnings({
      ...base,
      auth: { state: 'signed-out', reason: 'received a WorkBuddy AI credential', reasonCode: 'credential-region-mismatch' },
    })
    expect(warnings[0]).toMatchObject({ code: 'credential-unusable', level: 'error' })
    expect(warnings[0]?.message).toContain('received a WorkBuddy AI credential')
  })

  it('reports expired and expiring refresh state', () => {
    const now = Date.now()
    const expired = buildWarnings({
      ...base,
      now,
      auth: { state: 'signed-in', expiresAtMs: now - 1, refreshExpiresAtMs: now - 1 },
    })
    expect(expired.map((warning) => warning.code)).toEqual(['token-expired', 'refresh-expired'])
  })

  it('reports catalog, credits, expiry, and rate warnings', () => {
    const now = Date.now()
    const warnings = buildWarnings({
      ...base,
      now,
      catalogSource: 'builtin',
      catalogError: 'upstream 502',
      creditsError: 'billing offline',
      credits: {
        total: 10,
        accounts: [{ packageName: 'p', remain: 10, size: 10 }],
        expiry: { within24h: { total: 10, packages: 1 }, within3d: { total: 10, packages: 1 }, within7d: { total: 10, packages: 1 } },
      },
      rateUnknownCount: 2,
    })
    expect(warnings.map((warning) => warning.code)).toEqual([
      'catalog-error',
      'credits-error',
      'credits-expiring-24h',
      'rate-unknown',
    ])
    expect(warnings[0]?.message).toContain('内置模型列表')
  })
})

describe('buildProviderStatus', () => {
  it('builds the full document with masked credential metadata only', () => {
    const status = buildProviderStatus({
      descriptor: DESCRIPTOR,
      auth: { state: 'signed-in', expiresAtMs: 123, source: 'desktop' },
      credential: { source: 'app', writable: false, masked: '****oken', expiresAt: 123 },
      account: { label: 'Alice', detail: 'uid ****uid-1 · www.codebuddy.cn', enterprise: true },
      credentialError: undefined,
      transportError: undefined,
      catalog: { source: 'live', updatedAt: 5, models: [] },
      credits: undefined,
      probeConsent: true,
      probeRows: [],
      warnings: [],
    })
    expect(status).toMatchObject({
      id: 'workbuddy',
      family: 'workbuddy',
      region: 'cn',
      state: 'ready',
      account: { label: 'Alice', enterprise: true },
      credential: { source: 'app', masked: '****oken', writable: false },
      catalog: { source: 'live', updatedAt: 5 },
      probes: { supported: true, consent: true, rows: [] },
      capabilities: { usage: true, checkin: true, transfer: false, probes: true, multiAccount: false },
    })
    expect(JSON.stringify(status)).not.toContain('secret')
  })

  it('maps signed-out, diagnosable, and hard-error states', () => {
    const base = {
      descriptor: DESCRIPTOR,
      credential: undefined,
      account: {},
      credentialError: undefined,
      transportError: undefined,
      catalog: { source: 'builtin' as const, models: [] },
      credits: undefined,
      probeConsent: false,
      probeRows: [],
      warnings: [],
    }
    expect(
      buildProviderStatus({ ...base, auth: { state: 'signed-out', reasonCode: 'no-credential' } }).state,
    ).toBe('needs-credential')
    expect(
      buildProviderStatus({ ...base, auth: { state: 'signed-out', reason: 'bad file' } }).state,
    ).toBe('error')
    expect(
      buildProviderStatus({ ...base, auth: { state: 'signed-in' }, transportError: 'loopback failed' }).state,
    ).toBe('error')
    expect(
      buildProviderStatus({ ...base, auth: { state: 'signed-in' }, credentialError: 'token expired' }).state,
    ).toBe('error')
  })

  it('maps probe record states', () => {
    expect(probeStateOf('validating')).toBe('ok')
    expect(probeStateOf('non-validating')).toBe('inconclusive')
    expect(probeStateOf('unknown')).toBe('unknown')
  })
})
