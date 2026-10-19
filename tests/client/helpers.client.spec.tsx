// @vitest-environment jsdom
/** Pure helper, preference store and status-engine tests (no React, no network). */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  actionBusyKey,
  actionErrorText,
  actionSuccessText,
  allModelIds,
  checkinLogText,
  creditSummary,
  effectiveCheckin,
  effectiveCredits,
  familyHealth,
  filterModels,
  findProvider,
  formatClockMinute,
  formatDateTime,
  formatMultiplier,
  formatNumber,
  formatTokenWindow,
  localizedServerLabel,
  warningText,
  modelCounts,
  nextCheckinAt,
  parseClockMinute,
  progressPercent,
  providerIdOf,
  relativeBucket,
  relativeText,
  selectedProviderOf,
  expiryLevel,
} from '../../src/client/format.ts'
import type { ConnectHubTranslate } from '../../src/client/format.ts'
import { CLIENT_PREFERENCES_STORAGE_KEY, ClientPreferencesStore } from '../../src/client/prefs.ts'
import { ComposerStatusSource, HubStatusSource } from '../../src/client/status-source.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { ConnectHubKey } from '../../src/client/locales.ts'
import { buildAllProviders, buildCheckin, buildHubStatus, buildModel, buildPlanCredits, buildProvider, buildQoderReady, NOW } from './fixtures.ts'

function makeT(locale: 'zh' | 'en' = 'zh'): ConnectHubTranslate {
  const dictionary: Record<string, string> = locale === 'zh' ? zh : en
  const translate = (key: ConnectHubKey, params?: Record<string, unknown>): string => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (
      params[name] === undefined ? match : String(params[name])
    ))
  }
  return translate as ConnectHubTranslate
}

describe('localized host data', () => {
  it('renders known warning codes from the active dictionary, not the host sentence', () => {
    const warning = { code: 'credits-error', level: 'warn' as const, message: '额度读取失败：billing offline' }
    expect(warningText(makeT('zh'), warning)).toBe(zh.warningCreditsError)
    expect(warningText(makeT('en'), warning)).toBe(en.warningCreditsError)
    expect(warningText(makeT('en'), warning)).not.toContain('额度')
  })

  it('localizes Qoder desktop-sign-in warnings without PAT wording', () => {
    const rejected = { code: 'desktop-credential-rejected', level: 'error' as const, message: 'host sentence' }
    expect(warningText(makeT('en'), rejected)).toBe(en.warningDesktopCredentialRejected)
    expect(warningText(makeT('zh'), rejected)).toBe(zh.warningDesktopCredentialRejected)
    expect(warningText(makeT('en'), rejected)).not.toContain('PAT is invalid')
    const unsupported = { code: 'desktop-login-unsupported', level: 'info' as const, message: 'host sentence' }
    expect(warningText(makeT('en'), unsupported)).toBe(en.warningDesktopLoginUnsupported)
    expect(warningText(makeT('zh'), unsupported)).toBe(zh.warningDesktopLoginUnsupported)
    const unreadable = { code: 'desktop-login-unreadable', level: 'info' as const, message: 'host sentence' }
    expect(warningText(makeT('en'), unreadable)).toBe(en.warningDesktopLoginUnreadable)
    const expiredToken = { code: 'token-expired', level: 'warn' as const, message: 'host sentence' }
    expect(warningText(makeT('en'), expiredToken)).toBe(en.warningTokenExpired)
  })

  it('passes numeric parameters to count-based warnings', () => {
    const warning = {
      code: 'credits-expiring-24h',
      level: 'warn' as const,
      message: '有 120 积分将在 24 小时内过期，请尽快使用',
      params: { count: 120 },
    }
    expect(warningText(makeT('en'), warning)).toBe('120 credits expire within 24 hours; use them soon.')
    expect(warningText(makeT('zh'), warning)).toBe('有 120 积分将在 24 小时内过期，请尽快使用')
  })

  it('falls back to the host sentence for an unknown code', () => {
    const warning = { code: 'future-warning', level: 'info' as const, message: 'new host message' }
    expect(warningText(makeT('en'), warning)).toBe('new host message')
  })
  it('localizes known action success and failure codes, falling back to host text', () => {
    expect(actionSuccessText(makeT('en'), { code: 'catalog-refreshed', params: { count: 12 }, message: '模型目录已刷新' }))
      .toBe('Model catalog refreshed (12 models)')
    expect(actionSuccessText(makeT('zh'), { code: 'models-enabled', params: { count: 2 }, message: '已启用 2 个模型' }))
      .toBe('已启用 2 个模型')
    expect(actionSuccessText(makeT('en'), { message: 'host sentence' })).toBe('host sentence')
    expect(actionErrorText(makeT('en'), { error: 'probe_forbidden', detail: '未开启推理档位探测授权' }))
      .toBe(en.actionProbeForbidden)
    expect(actionErrorText(makeT('en'), { error: 'stale_identity', detail: '账号已切换' })).toBe('账号已切换')
    expect(actionErrorText(makeT('en'), { error: 'action_failed' })).toBe(en.actionRejected)
  })

  it('localizes check-in log rows by code and keeps old rows readable', () => {
    expect(checkinLogText(makeT('en'), { code: 'checkin-claimed', params: { reward: 100 }, message: '签到成功' }))
      .toBe('Checked in; earned 100 credits')
    expect(checkinLogText(makeT('zh'), { code: 'checkin-device-used', message: '旧记录' }))
      .toBe(zh.checkinLogDeviceUsed)
    expect(checkinLogText(makeT('en'), { message: '旧记录' })).toBe('旧记录')
  })

  it('localizes the finite host plan/package and Trae edition labels', () => {
    for (const [value, key] of [
      ['不限额度', 'planUnlimited'],
      ['个人额度', 'planPersonal'],
      ['组织资源包', 'planOrganization'],
      ['赠送额度', 'planGift'],
      ['专属资源包', 'planExclusive'],
      ['国内桌面版', 'traeEditionCnDesktop'],
      ['SOLO 国际版', 'traeEditionGlobalSolo'],
      ['免费', 'badgeFree'],
    ] as const) {
      expect(localizedServerLabel(makeT('en'), value)).toBe(en[key])
      expect(localizedServerLabel(makeT('zh'), value)).toBe(zh[key])
    }
    expect(localizedServerLabel(makeT('en'), 'upstream-only package')).toBe('upstream-only package')
  })
})

describe('format helpers', () => {
  it('groups digits and formats multipliers', () => {
    expect(formatNumber(1234.4)).toBe('1,234')
    expect(formatNumber(0)).toBe('0')
    expect(formatMultiplier(1)).toBe('×1')
    expect(formatMultiplier(0.5)).toBe('×0.5')
    expect(formatMultiplier(2.25)).toBe('×2.25')
  })

  it('formats context windows compactly', () => {
    expect(formatTokenWindow(131_072)).toBe('131K')
    expect(formatTokenWindow(1_000_000)).toBe('1M')
    expect(formatTokenWindow(32_768)).toBe('33K')
    expect(formatTokenWindow(0)).toBe('0')
  })

  it('formats and parses the check-in clock', () => {
    expect(formatClockMinute(600)).toBe('10:00')
    expect(formatClockMinute(0)).toBe('00:00')
    expect(formatClockMinute(1439)).toBe('23:59')
    expect(parseClockMinute('10:00')).toBe(600)
    expect(parseClockMinute('9:05')).toBe(545)
    expect(parseClockMinute('24:00')).toBeUndefined()
    expect(parseClockMinute('10:60')).toBeUndefined()
    expect(parseClockMinute('noon')).toBeUndefined()
  })

  it('schedules the next UTC+8 check-in strictly after now', () => {
    // NOW is 11:00 in UTC+8, so today's 10:00 slot has passed.
    expect(nextCheckinAt(600, NOW)).toBe(Date.UTC(2026, 9, 19, 2, 0, 0))
    // 12:00 UTC+8 is still ahead today.
    expect(nextCheckinAt(720, NOW)).toBe(Date.UTC(2026, 9, 18, 4, 0, 0))
  })

  it('computes clamped progress percentages', () => {
    expect(progressPercent(50, 100)).toBe(50)
    expect(progressPercent(0, 100)).toBe(0)
    expect(progressPercent(200, 100)).toBe(100)
    expect(progressPercent(1, 0)).toBeUndefined()
    expect(progressPercent(undefined, 100)).toBeUndefined()
  })

  it('buckets relative time and localizes it', () => {
    expect(relativeBucket(NOW - 10_000, NOW)).toEqual({ unit: 'now', n: 0 })
    expect(relativeBucket(NOW - 5 * 60_000, NOW)).toEqual({ unit: 'minutes', n: 5 })
    expect(relativeBucket(NOW - 3 * 3_600_000, NOW)).toEqual({ unit: 'hours', n: 3 })
    expect(relativeBucket(NOW - 2 * 86_400_000, NOW)).toEqual({ unit: 'days', n: 2 })
    const t = makeT('zh')
    expect(relativeText(t, NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(relativeText(makeT('en'), NOW - 3_600_000, NOW)).toBe('1h ago')
  })

  it('formats absolute date-times without throwing on missing values', () => {
    expect(formatDateTime(0)).toBe('—')
    expect(formatDateTime(NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('classifies expiries', () => {
    expect(expiryLevel(undefined, NOW)).toBeUndefined()
    expect(expiryLevel(NOW - 1, NOW)).toBe('expired')
    expect(expiryLevel(NOW + 3_600_000, NOW)).toBe('soon')
    expect(expiryLevel(NOW + 30 * 86_400_000, NOW)).toBe('ok')
  })

  it('filters models by name, id and badge, and counts enabled ones', () => {
    const models = [
      buildModel({ id: 'a', name: 'Alpha', badges: [] }),
      buildModel({ id: 'b', name: 'Beta', badges: ['免费'], enabled: false }),
    ]
    expect(filterModels(models, '')).toHaveLength(2)
    expect(filterModels(models, 'alph').map((model) => model.id)).toEqual(['a'])
    expect(filterModels(models, '免费').map((model) => model.id)).toEqual(['b'])
    expect(filterModels(models, 'zzz')).toEqual([])
    expect(modelCounts(models)).toEqual({ enabled: 1, total: 2 })
    expect(allModelIds(models)).toEqual(['a', 'b'])
  })

  it('reads the selected provider from the model-selection projection', () => {
    expect(selectedProviderOf(undefined)).toBeUndefined()
    expect(selectedProviderOf(null)).toBeUndefined()
    expect(selectedProviderOf({ next: { provider: 'qoder' }, lastUsed: { provider: 'trae' } })).toBe('qoder')
    expect(selectedProviderOf({ next: null, lastUsed: { provider: 'trae' } })).toBe('trae')
    expect(selectedProviderOf({ next: { provider: 'deepseek-official' } })).toBeUndefined()
    expect(selectedProviderOf({ next: { provider: 42 } })).toBeUndefined()
  })

  it('maps families to provider routes', () => {
    expect(providerIdOf('qoder', 'cn')).toBe('qoder')
    expect(providerIdOf('qoder', 'global')).toBe('qoder-global')
    expect(providerIdOf('workbuddy', 'global')).toBe('workbuddy-ai')
    expect(providerIdOf('trae', 'cn')).toBe('trae')
  })

  it('builds stable busy keys', () => {
    expect(actionBusyKey({ type: 'refresh-usage', provider: 'trae' })).toBe('refresh-usage:trae:')
    expect(actionBusyKey({ type: 'set-model-enabled', provider: 'qoder', modelId: 'm1' })).toBe('set-model-enabled:qoder:m1')
    expect(actionBusyKey({ type: 'checkin', provider: 'trae', accountId: 'acct-1' })).toBe('checkin:trae::acct-1')
    expect(actionBusyKey({ type: 'checkin', provider: 'qoder' })).toBe('checkin:qoder:')
  })
})

describe('provider data helpers', () => {
  it('aggregates family health with the worst state winning', () => {
    const status = buildHubStatus(buildAllProviders())
    const health = familyHealth(status)
    expect(health.map((item) => item.family)).toEqual(['qoder', 'workbuddy', 'trae'])
    // One ready region is enough for a READY family chip; `partial` records the mix.
    expect(health[0]?.state).toBe('ready')
    expect(health[1]?.state).toBe('ready')
    expect(health[2]?.state).toBe('ready')
    expect(health.map((item) => item.partial)).toEqual([true, true, true])
    expect(health[0]?.ready).toBe(1)
    expect(health[0]?.total).toBe(2)
    expect(familyHealth(null).every((item) => item.state === 'unknown')).toBe(true)
  })

  it('resolves effective credits/check-in from the selected account', () => {
    const trae = buildAllProviders().find((provider) => provider.id === 'trae')
    expect(trae).toBeDefined()
    if (trae === undefined) return
    expect(effectiveCredits(trae)?.remaining).toBe(800)
    expect(effectiveCheckin(trae)?.enabled).toBe(true)
    expect(findProvider(buildHubStatus(buildAllProviders()), 'qoder')?.state).toBe('ready')
    expect(findProvider(buildHubStatus([]), 'qoder')).toBeUndefined()
  })

  it('summarizes credits for the composer readout', () => {
    const qoder = buildQoderReady()
    expect(creditSummary(qoder)).toEqual({ amount: 1_240 })
    expect(creditSummary(buildProvider('qoder', { credits: buildPlanCredits('Pro') }))).toEqual({ plan: 'Pro' })
    expect(creditSummary(buildProvider('qoder'))).toBeUndefined()
    expect(effectiveCheckin(buildProvider('qoder', { checkin: buildCheckin({ enabled: false }) }))?.enabled).toBe(false)
  })
})

describe('client preferences store', () => {
  function memoryStorage(): { storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }; data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
      data,
      storage: {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => { data.set(key, value) },
      },
    }
  }

  it('starts with the toolbar seat and CN region', () => {
    const store = new ClientPreferencesStore(memoryStorage().storage)
    expect(store.get()).toEqual({ seat: 'toolbar', family: 'qoder', region: 'cn' })
  })

  it('persists changes and notifies subscribers once per real change', () => {
    const { storage, data } = memoryStorage()
    const store = new ClientPreferencesStore(storage)
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.get()
    store.setSeat('dock')
    store.setSeat('dock')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get()).not.toBe(before)
    expect(store.get().seat).toBe('dock')
    expect(JSON.parse(data.get(CLIENT_PREFERENCES_STORAGE_KEY) ?? '{}')).toEqual({ seat: 'dock', family: 'qoder', region: 'cn' })
  })

  it('ignores malformed storage', () => {
    const store = new ClientPreferencesStore({ getItem: () => '{', setItem: () => {} })
    expect(store.get().seat).toBe('toolbar')
    const legacy = new ClientPreferencesStore({ getItem: () => JSON.stringify({ seat: 'bogus', family: 'x', region: 'y' }), setItem: () => {} })
    expect(legacy.get()).toEqual({ seat: 'toolbar', family: 'qoder', region: 'cn' })
  })
})

describe('HubStatusSource', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('polls only while visible and clears its timer on stop', async () => {
    vi.useFakeTimers()
    let visible: 'visible' | 'hidden' = 'visible'
    const visibilityListeners: (() => void)[] = []
    const load = vi.fn(async () => buildHubStatus([buildQoderReady()], { revision: load.mock.calls.length }))
    const source = new HubStatusSource({
      load,
      intervalMs: 5_000,
      visibility: () => visible,
      subscribeVisibility: (listener) => { visibilityListeners.push(listener); return () => {} },
      now: () => NOW,
    })
    const listener = vi.fn()
    source.subscribe(listener)
    source.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot().status?.revision).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(2)

    visible = 'hidden'
    await vi.advanceTimersByTimeAsync(15_000)
    expect(load).toHaveBeenCalledTimes(2)

    visible = 'visible'
    visibilityListeners.forEach((listenerFn) => listenerFn())
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(3)

    source.stop()
    visible = 'visible'
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(3)
    expect(listener).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('does not churn subscribers when the revision is unchanged', async () => {
    const status = buildHubStatus([buildQoderReady()], { revision: 7 })
    const load = vi.fn(async () => status)
    const source = new HubStatusSource({ load, visibility: () => 'hidden', subscribeVisibility: () => () => {}, now: () => NOW })
    source.start()
    await vi.waitFor(() => { expect(source.getSnapshot().loading).toBe(false) })
    const listener = vi.fn()
    source.subscribe(listener)
    await source.reload()
    expect(listener).not.toHaveBeenCalled()
    // A genuinely different revision does publish.
    const newer = buildHubStatus([buildQoderReady({ state: 'error' })], { revision: 8 })
    load.mockImplementation(async () => newer)
    await source.reload()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot().status?.revision).toBe(8)
    source.stop()
  })

  it('keeps the cached status and records the error when a read fails', async () => {
    const load = vi.fn(async () => buildHubStatus([buildQoderReady()]))
    const source = new HubStatusSource({ load, visibility: () => 'hidden', subscribeVisibility: () => () => {}, now: () => NOW })
    source.start()
    await vi.waitFor(() => { expect(source.getSnapshot().loading).toBe(false) })
    load.mockRejectedValue(new Error('boom'))
    await source.refresh()
    expect(source.getSnapshot().error).toBe('boom')
    expect(source.getSnapshot().status).not.toBeNull()
    source.stop()
  })
})

describe('ComposerStatusSource', () => {
  it('reads at most once per freshness window and on manual refresh', async () => {
    let now = NOW
    const load = vi.fn(async () => buildHubStatus([buildQoderReady()]))
    const source = new ComposerStatusSource({ load, freshMs: 5 * 60_000, now: () => now })
    source.ensureFresh()
    await vi.waitFor(() => { expect(source.getSnapshot().status).not.toBeNull() })
    expect(load).toHaveBeenCalledTimes(1)

    now = NOW + 60_000
    source.ensureFresh()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)

    now = NOW + 6 * 60_000
    source.ensureFresh()
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2)
      expect(source.getSnapshot().loadedAt).toBe(NOW + 6 * 60_000)
    })

    await source.refresh()
    expect(load).toHaveBeenCalledTimes(3)
  })
})
