/** Offline coverage for the WorkBuddy daily check-in helpers and HTTP client. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkinStateOf,
  checkinViewOf,
  defaultWorkBuddyCheckinPrefs,
  formatCheckinMinute,
  normalizeCheckinMinute,
  parseWorkBuddyCheckinPrefs,
  shouldCatchUp,
  utc8DateOf,
  withCheckinLog,
} from '../../../src/providers/workbuddy/checkin.ts'
import { WorkBuddyUpstreamClient, type WorkBuddyCheckinActivity } from '../../../src/providers/workbuddy/upstream.ts'
import type { WorkBuddyCredential } from '../../../src/providers/workbuddy/auth.ts'

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0) // 2026-10-19 20:00 UTC+8

const ACTIVITY: WorkBuddyCheckinActivity = {
  active: true,
  todayCheckedIn: false,
  streakDays: 7,
  dailyCredit: 100,
  todayCredit: 0,
  totalCredits: 700,
  weekCheckinDays: 1,
  activityName: 'Buddy应用',
  themeName: 'Buddy加油站',
}

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'secret-access-token',
  refreshToken: 'secret-refresh-token',
  expiresAtMs: NOW + 3_600_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('check-in preferences', () => {
  it('parses defaults and round-trips persisted values', () => {
    expect(parseWorkBuddyCheckinPrefs(undefined)).toEqual(defaultWorkBuddyCheckinPrefs())
    const stored = parseWorkBuddyCheckinPrefs({
      enabled: true,
      minute: 0,
      lastAttemptAt: NOW,
      lastErrorAt: NOW,
      claimedDate: '2026-10-19',
      reward: 100,
      log: [{ at: NOW, ok: true, message: '签到成功', code: 'checkin-claimed', params: { reward: 100 } }],
    })
    expect(stored).toMatchObject({ enabled: true, minute: 0, claimedDate: '2026-10-19', reward: 100 })
    expect(stored.log[0]).toMatchObject({ code: 'checkin-claimed', params: { reward: 100 } })
    expect(parseWorkBuddyCheckinPrefs({ enabled: 'yes', minute: 2000 }).enabled).toBe(false)
    expect(parseWorkBuddyCheckinPrefs({ minute: 2000 }).minute).toBe(defaultWorkBuddyCheckinPrefs().minute)
  })

  it('keeps the newest log rows and normalizes minutes', () => {
    let prefs = defaultWorkBuddyCheckinPrefs()
    for (let index = 0; index < 35; index += 1) {
      prefs = withCheckinLog(prefs, { at: NOW + index, ok: true, message: String(index) })
    }
    expect(prefs.log).toHaveLength(30)
    expect(prefs.log[0]?.at).toBe(NOW + 34)
    expect(formatCheckinMinute(normalizeCheckinMinute(9 * 60 + 5)!)).toBe('09:05')
    expect(normalizeCheckinMinute(24 * 60)).toBeNull()
    expect(normalizeCheckinMinute(-1)).toBeNull()
  })

  it('derives state and view from the activity and the last attempt', () => {
    const prefs = { ...defaultWorkBuddyCheckinPrefs(), enabled: true, minute: 60 }
    expect(checkinStateOf(prefs, ACTIVITY, true, NOW)).toBe('available')
    expect(checkinViewOf(prefs, ACTIVITY, true, NOW)).toMatchObject({
      supported: true,
      enabled: true,
      minute: 60,
      state: 'available',
    })
    expect(checkinStateOf(prefs, { ...ACTIVITY, todayCheckedIn: true, todayCredit: 100 }, true, NOW)).toBe('claimed')
    expect(checkinViewOf(prefs, { ...ACTIVITY, todayCheckedIn: true, todayCredit: 100 }, true, NOW)).toMatchObject({
      state: 'claimed',
      reward: 100,
    })
    expect(checkinViewOf(prefs, { ...ACTIVITY, active: false }, true, NOW)).toMatchObject({
      supported: false,
      state: 'unknown',
    })
    expect(checkinStateOf({ ...prefs, lastErrorAt: NOW }, ACTIVITY, true, NOW)).toBe('error')
    expect(checkinStateOf(prefs, ACTIVITY, false, NOW)).toBe('unknown')
  })

  it('catches up only when enabled, past the minute, active and unclaimed', () => {
    const prefs = { ...defaultWorkBuddyCheckinPrefs(), enabled: true, minute: 9 * 60 }
    expect(shouldCatchUp(prefs, ACTIVITY, true, NOW)).toBe(true)
    expect(shouldCatchUp({ ...prefs, enabled: false }, ACTIVITY, true, NOW)).toBe(false)
    expect(shouldCatchUp({ ...prefs, minute: 23 * 60 + 59 }, ACTIVITY, true, NOW)).toBe(false)
    expect(shouldCatchUp(prefs, { ...ACTIVITY, todayCheckedIn: true }, true, NOW)).toBe(false)
    expect(shouldCatchUp(prefs, ACTIVITY, false, NOW)).toBe(false)
    expect(shouldCatchUp({ ...prefs, claimedDate: utc8DateOf(NOW) }, ACTIVITY, true, NOW)).toBe(false)
    expect(utc8DateOf(NOW)).toBe('2026-10-19')
  })
})

describe('check-in upstream client', () => {
  it('reads the activity with the billing auth headers', async () => {
    const calls: { url?: string, init?: RequestInit | undefined } = {}
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      calls.url = String(url)
      calls.init = init
      return new Response(JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          active: true,
          today_checked_in: true,
          streak_days: 7,
          daily_credit: 100,
          today_credit: 100,
          total_credits: 700,
          week_checkin_days: 1,
          activity_name: 'Buddy应用',
          theme_name: 'Buddy加油站',
          end_time: '2026-10-31 23:59:59',
        },
      }), { status: 200 })
    })
    const activity = await new WorkBuddyUpstreamClient().fetchCheckinStatus(CREDENTIAL)
    expect(calls.url).toBe('https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status')
    expect(calls.init?.method).toBe('POST')
    const headers = calls.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer secret-access-token')
    expect(headers['X-User-Id']).toBe('uid-1')
    expect(activity).toMatchObject({
      active: true,
      todayCheckedIn: true,
      streakDays: 7,
      dailyCredit: 100,
      todayCredit: 100,
      totalCredits: 700,
      endTime: '2026-10-31 23:59:59',
    })
  })

  it('posts the claim and parses a credited answer', async () => {
    vi.stubGlobal('fetch', async (url: unknown) => {
      expect(String(url)).toBe('https://www.codebuddy.cn/v2/billing/meter/daily-checkin')
      return new Response(JSON.stringify({ code: 0, msg: 'OK', data: { credit: 100 } }), { status: 200 })
    })
    await expect(new WorkBuddyUpstreamClient().claimDailyCheckin(CREDENTIAL))
      .resolves.toEqual({ ok: true, credit: 100 })
  })

  it('reports a business failure from the claim answer', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      msg: 'OK',
      data: { code: 11128, msg: 'already checked in today' },
    }), { status: 200 }))
    await expect(new WorkBuddyUpstreamClient().claimDailyCheckin(CREDENTIAL))
      .resolves.toEqual({ ok: false, code: 11128, message: 'already checked in today' })
  })

  it('fails a non-zero envelope instead of claiming success', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 500, msg: 'billing offline' }), { status: 200 }))
    await expect(new WorkBuddyUpstreamClient().claimDailyCheckin(CREDENTIAL))
      .resolves.toEqual({ ok: false, code: 500, message: 'billing offline' })
    await expect(new WorkBuddyUpstreamClient().fetchCheckinStatus(CREDENTIAL))
      .rejects.toThrow(/billing offline/)
  })
})
