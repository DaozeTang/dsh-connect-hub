import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QoderAuthService } from '../../../src/providers/qoder/qoder/transport/auth.ts'
import { QoderCheckInService, type QoderCheckInResult } from '../../../src/providers/qoder/qoder/transport/checkin.ts'
import {
  applyCheckinResult,
  checkinLogRow,
  checkinMessage,
  checkinStateOf,
  checkinViewOf,
  DEFAULT_CHECK_IN_MINUTE,
  isPastCheckInTime,
  normalizeCheckInMinute,
  settledToday,
  shouldCatchUp,
} from '../../../src/providers/qoder/checkin.ts'
import { defaultPrefs, type QoderPrefs } from '../../../src/providers/qoder/prefs.ts'
import { formatUtc8Date } from '../../../src/providers/qoder/utc8.ts'
import { captureFetch, json } from './fakes.ts'

describe('check-in scheduling helpers', () => {
  it('normalizes stored minutes onto a claimable moment', () => {
    expect(normalizeCheckInMinute(600)).toBe(600)
    expect(normalizeCheckInMinute(615)).toBe(615)
    expect(normalizeCheckInMinute(120)).toBe(600)
    expect(normalizeCheckInMinute(1439)).toBe(1439)
    expect(normalizeCheckInMinute(1440)).toBe(600)
    expect(normalizeCheckInMinute(-1)).toBe(600)
    expect(normalizeCheckInMinute(Number.NaN)).toBe(600)
    expect(normalizeCheckInMinute('600')).toBe(DEFAULT_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(undefined)).toBe(DEFAULT_CHECK_IN_MINUTE)
  })

  it('reads the configured moment in UTC+8', () => {
    // 10:00 UTC+8 is 02:00 UTC.
    expect(isPastCheckInTime(600, Date.parse('2026-10-18T01:59:00Z'))).toBe(false)
    expect(isPastCheckInTime(600, Date.parse('2026-10-18T02:00:00Z'))).toBe(true)
    expect(isPastCheckInTime(615, Date.parse('2026-10-18T02:10:00Z'))).toBe(false)
    expect(isPastCheckInTime(615, Date.parse('2026-10-18T02:15:00Z'))).toBe(true)
  })

  it('formats the UTC+8 calendar date across the local midnight', () => {
    expect(formatUtc8Date(Date.parse('2026-10-18T15:59:00Z'))).toBe('2026-10-18')
    expect(formatUtc8Date(Date.parse('2026-10-18T16:00:00Z'))).toBe('2026-10-19')
  })

  it('settles a day only after an actual claim', () => {
    const now = Date.parse('2026-10-18T03:00:00Z')
    const claimed: QoderPrefs = {
      ...defaultPrefs(),
      checkin: {
        enabled: true,
        minute: 600,
        record: { date: '2026-10-18', status: 'claimed', lastAt: now - 1000, amount: 100 },
        logs: [],
      },
    }
    expect(settledToday(claimed.checkin, now)).toBe(true)
    expect(shouldCatchUp(claimed.checkin, now)).toBe(false)

    const earlierWindow: QoderPrefs = {
      ...claimed,
      checkin: { ...claimed.checkin, record: { date: '2026-10-17', status: 'before-window', lastAt: now - 86_400_000 } },
    }
    expect(settledToday(earlierWindow.checkin, now)).toBe(false)
    expect(shouldCatchUp(earlierWindow.checkin, now)).toBe(true)

    const disabled: QoderPrefs = { ...earlierWindow, checkin: { ...earlierWindow.checkin, enabled: false } }
    expect(shouldCatchUp(disabled.checkin, now)).toBe(false)

    // Before the configured moment the provider's own timer still owns today.
    expect(shouldCatchUp(disabled.checkin, Date.parse('2026-10-18T01:00:00Z'))).toBe(false)
  })

  it('folds a result into the record and bounded log', () => {
    const at = Date.parse('2026-10-18T03:00:00Z')
    const result: QoderCheckInResult = {
      variantId: 'qoder',
      date: '2026-10-18',
      timestamp: at,
      status: 'claimed',
      amount: 100,
      message: 'Successfully claimed 100 credits',
    }
    const next = applyCheckinResult(defaultPrefs(), result)
    expect(next.checkin.record).toEqual({ date: '2026-10-18', status: 'claimed', lastAt: at, amount: 100 })
    expect(next.checkin.logs).toEqual([{
      at,
      ok: true,
      message: '签到成功，获得 100 积分',
      code: 'checkin-claimed',
      params: { reward: 100 },
    }])

    let capped = defaultPrefs()
    for (let index = 0; index < 35; index++) {
      capped = applyCheckinResult(capped, { ...result, timestamp: at + index })
    }
    expect(capped.checkin.logs).toHaveLength(30)
    expect(capped.checkin.logs[0]?.at).toBe(at + 34)
  })

  it('maps each result status to a user-facing row', () => {
    const base: QoderCheckInResult = {
      variantId: 'qoder',
      date: '2026-10-18',
      timestamp: 1,
      status: 'error',
    }
    expect(checkinMessage({ ...base, status: 'claimed', amount: 50 })).toBe('签到成功，获得 50 积分')
    expect(checkinMessage({ ...base, status: 'already-claimed' })).toBe('今日已签到')
    expect(checkinMessage({ ...base, status: 'before-window' })).toBe('签到窗口尚未开放，请稍后再试')
    expect(checkinMessage({ ...base, status: 'no-campaign' })).toBe('当前区域暂无可领取的签到活动')
    expect(checkinMessage({ ...base, status: 'error', message: 'network down' })).toBe('签到失败：network down')
    expect(checkinLogRow({ ...base, status: 'claimed' })).toMatchObject({ at: 1, ok: true })
    expect(checkinLogRow({ ...base, status: 'error' })).toMatchObject({ at: 1, ok: false })
  })

  it('derives the contract check-in state', () => {
    const now = Date.parse('2026-10-18T03:00:00Z')
    const prefs = defaultPrefs()
    expect(checkinStateOf(prefs, false, now)).toBe('unknown')
    expect(checkinStateOf(prefs, true, now)).toBe('available')

    const claimed: QoderPrefs = {
      ...prefs,
      checkin: { ...prefs.checkin, record: { date: '2026-10-18', status: 'claimed', lastAt: now } },
    }
    expect(checkinStateOf(claimed, true, now)).toBe('claimed')

    const failed: QoderPrefs = {
      ...prefs,
      checkin: { ...prefs.checkin, record: { date: '2026-10-18', status: 'error', lastAt: now } },
    }
    expect(checkinStateOf(failed, true, now)).toBe('error')

    const view = checkinViewOf(claimed, true, now)
    expect(view).toMatchObject({ supported: true, enabled: false, minute: 600, state: 'claimed' })
  })
})

interface FakeAuthService {
  service: QoderAuthService
  freshCalls: () => number
}

function fakeAuthService(): FakeAuthService {
  let freshCalls = 0
  const credentials = { userID: 'user-1', authToken: 'job-token-1', name: 'Tester', email: '' }
  const service = {
    getCredentials: async () => credentials,
    exchangeFresh: async () => {
      freshCalls += 1
      return { ...credentials, authToken: 'job-token-2' }
    },
    clear: () => {},
  }
  return { service: service as unknown as QoderAuthService, freshCalls: () => freshCalls }
}

const NOW_ISO = '2026-10-18T03:00:00.000Z'
const TODAY_10_UTC8 = Date.UTC(2026, 9, 18, 2, 0, 0) / 1000

function campaign(startAt: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: 'campaign-1',
    campaignKey: 'daily',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'AVAILABLE',
    startAt,
    endAt: startAt + 86_340,
    benefit: { amount: 100 },
    ...overrides,
  }
}

const CAMPAIGNS_URL = 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns'
const CLAIM_URL = 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/campaign-1/claim'

describe('QoderCheckInService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW_ISO))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function serviceWith(
    routes: (url: string) => Response | undefined,
    auth = fakeAuthService(),
  ): { service: QoderCheckInService; auth: FakeAuthService; requests: ReturnType<typeof captureFetch>['requests'] } {
    const fake = captureFetch(routes)
    return {
      service: new QoderCheckInService({
        authService: auth.service,
        fetch: fake.fetch,
        region: 'china',
        variantId: 'qoder',
      }),
      auth,
      requests: fake.requests,
    }
  }

  it('reports no campaign when the region serves none', async () => {
    const { service } = serviceWith(url => url === CAMPAIGNS_URL ? json({ campaigns: [] }) : undefined)
    const result = await service.checkIn('pat')
    expect(result).toMatchObject({ variantId: 'qoder', date: '2026-10-18', status: 'no-campaign' })
  })

  it('reports an already claimed day with the reward', async () => {
    const { service } = serviceWith(url => url === CAMPAIGNS_URL
      ? json({ campaigns: [campaign(TODAY_10_UTC8, { claimStatus: 'CLAIMED', benefit: { amount: 120 } })] })
      : undefined)
    const result = await service.checkIn('pat')
    expect(result).toMatchObject({ status: 'already-claimed', amount: 120 })
  })

  it('claims an available campaign with the desktop client identifier', async () => {
    const { service, requests } = serviceWith((url) => {
      if (url === CAMPAIGNS_URL) return json({ campaigns: [campaign(TODAY_10_UTC8)] })
      if (url === CLAIM_URL) return json({ status: 'CLAIMED', benefit: { amount: 120 } })
      return undefined
    })
    const result = await service.checkIn('pat')
    expect(result).toMatchObject({ status: 'claimed', amount: 120 })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe(CAMPAIGNS_URL)
    expect(requests[0]?.headers['cosy-clienttype']).toBe('10')
    expect(requests[1]).toMatchObject({ url: CLAIM_URL, method: 'POST' })
    expect(requests[1]?.headers['origin']).toBe('https://openapi.qoder.com.cn')
    expect(requests[1]?.headers['cosy-clienttype']).toBe('10')
    expect(requests[1]?.headers['authorization']).toBe('Bearer job-token-1')
  })

  it("does not claim before the window opens or while yesterday is still served", async () => {
    const futures = serviceWith(url => url === CAMPAIGNS_URL
      ? json({ campaigns: [campaign(TODAY_10_UTC8 + 86_400)] })
      : undefined)
    expect(await futures.service.checkIn('pat')).toMatchObject({ status: 'before-window' })

    const earlier = serviceWith(url => url === CAMPAIGNS_URL
      ? json({ campaigns: [campaign(TODAY_10_UTC8 - 86_400)] })
      : undefined)
    expect(await earlier.service.checkIn('pat')).toMatchObject({ status: 'before-window' })
    expect(earlier.requests).toHaveLength(1)
  })

  it('reports an error when the claim is not accepted', async () => {
    const { service } = serviceWith((url) => {
      if (url === CAMPAIGNS_URL) return json({ campaigns: [campaign(TODAY_10_UTC8)] })
      if (url === CLAIM_URL) return json({ status: 'PENDING' })
      return undefined
    })
    const result = await service.checkIn('pat')
    expect(result).toMatchObject({ status: 'error' })
    expect(result.message).toContain('PENDING')
  })

  it('retries once with a freshly exchanged job token after a rejection', async () => {
    let campaignCalls = 0
    const auth = fakeAuthService()
    const { service } = serviceWith((url) => {
      if (url !== CAMPAIGNS_URL) return undefined
      campaignCalls += 1
      if (campaignCalls === 1) return json({ error: 'unauthorized' }, 401)
      return json({ campaigns: [campaign(TODAY_10_UTC8, { claimStatus: 'CLAIMED' })] })
    }, auth)
    const result = await service.checkIn('pat')
    expect(result.status).toBe('already-claimed')
    expect(auth.freshCalls()).toBe(1)
    expect(campaignCalls).toBe(2)
  })
})
