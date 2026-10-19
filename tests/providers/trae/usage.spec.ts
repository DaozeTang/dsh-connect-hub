import { describe, expect, it } from 'vitest'
import type { TraeCredential } from '../../../src/providers/trae/auth.ts'
import {
  checkinClaimOutcome,
  checkinPreflight,
  checkinSnapshotOf,
  checkinStateOf,
  checkinViewOf,
  creditsViewOfPayStatus,
  creditsViewOfSnapshot,
} from '../../../src/providers/trae/usage-view.ts'
import { TraeUsageClient } from '../../../src/providers/trae/usage.ts'

const credential: TraeCredential = {
  accessToken: 'fake-token',
  userId: 'u1',
  host: 'https://api.trae.cn',
  edition: 'cn',
  source: 'desktop',
  expiresAtMs: Date.now() + 3_600_000,
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function clientFor(routes: Record<string, unknown>, options: { credential?: TraeCredential } = {}): TraeUsageClient {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const path = new URL(url).pathname
    const body = routes[path]
    if (body === undefined) return respond({ error: 'not found' }, 404)
    return respond(body)
  }) as typeof fetch
  const client = new TraeUsageClient({
    credential: async () => options.credential ?? credential,
    deviceId: async () => 'device-123',
    fetchImpl,
    baseUrl: 'https://api.trae.cn',
  })
  return client
}

describe('TraeUsageClient CN parsing', () => {
  it('normalizes the credit snapshot: seconds expiry becomes ms, packs project quota minus consumed', async () => {
    const client = clientFor({
      '/trae/api/v2/pay/web_user_ent_usage': {
        is_credits_billing: true,
        usage_summary: { total_amount: 100, consumed_amount: 25, consumption_ratio: 0.25 },
        user_entitlement_pack_list: [{
          display_desc: '通用额度包',
          entitlement_base_info: {
            entitlement_id: 'pack-1',
            quota: { credits_limit: 60 },
            end_time: 1788340660,
            available_endpoint: 1,
          },
          usage: { credits_amount: 10 },
        }],
      },
    })
    const view = creditsViewOfSnapshot(await client.snapshot(), 1_700_000_000_000)
    expect(view.kind).toBe('credits')
    expect(view.total).toBe(100)
    expect(view.remaining).toBe(75)
    expect(view.updatedAt).toBe(1_700_000_000_000)
    expect(view.packages).toEqual([{
      id: 'pack-1',
      name: '通用额度包',
      remaining: 50,
      total: 60,
      expiresAt: 1788340660000,
    }])
  })

  it('reads check-in state with the account-level and device-level flags kept apart', async () => {
    const client = clientFor({
      '/trae/api/v2/ug/checkin_credits/status': {
        checked_in: false,
        did_checked_in: true,
        credits: 20,
        extra_credits: 5,
        enable: true,
      },
    })
    const status = await client.checkinStatus()
    expect(status).toMatchObject({ checkedIn: false, didCheckedIn: true, credits: 20, extraCredits: 5, enabled: true })
    const snapshot = checkinSnapshotOf(status, 42)
    expect(checkinStateOf(snapshot)).toBe('device-used')
    expect(checkinViewOf(snapshot, { enabled: true, minute: 540, log: [] })).toMatchObject({
      state: 'device-used',
      enabled: true,
      minute: 540,
      reward: 25,
    })
  })

  it('never reports "claimed" for a device-only check-in from another account', async () => {
    expect(checkinStateOf(checkinSnapshotOf({ checkedIn: false, didCheckedIn: true, credits: 0, enabled: true }))).toBe('device-used')
    expect(checkinStateOf(checkinSnapshotOf({ checkedIn: true, didCheckedIn: true, credits: 10, enabled: true }))).toBe('claimed')
    expect(checkinStateOf(undefined)).toBe('unknown')
    expect(checkinStateOf({ checkedIn: false, didCheckedIn: false, credits: 0, enabled: true, readAt: 1, error: 'boom' })).toBe('error')
  })

  it('rejects the CN-only endpoints for the international region', async () => {
    const client = clientFor({}, { credential: { ...credential, edition: 'sg', host: 'https://growsg-normal.trae.ai' } })
    await expect(client.snapshot()).rejects.toThrow(/only available for the CN region/)
  })
})

describe('TraeUsageClient international subscription', () => {
  it('reads the plan identity rather than the CN package flag', async () => {
    const client = clientFor({
      '/trae/api/v1/pay/ide_user_pay_status': {
        is_dollar_usage_billing: true,
        has_package: false,
        user_pay_identity: 2,
        user_pay_identity_str: 'Pro',
        enable_solo_coder: true,
      },
    }, { credential: { ...credential, edition: 'sg', host: 'https://growsg-normal.trae.ai' } })
    const payStatus = await client.payStatus()
    expect(payStatus).toMatchObject({ hasPackage: false, payIdentity: 2, payIdentityStr: 'Pro', enableSoloCoder: true })
    expect(creditsViewOfPayStatus(payStatus, 7)).toEqual({ kind: 'subscription', plan: 'Pro', updatedAt: 7, packages: [] })
  })

  it('refuses the CN work-credit snapshot on the international region', async () => {
    const client = clientFor({}, { credential: { ...credential, edition: 'sg', host: 'https://growsg-normal.trae.ai' } })
    await expect(client.checkinStatus()).rejects.toThrow(/CN region/)
  })
})

describe('check-in state machine', () => {
  it('prefers the account reward over the device tally', () => {
    expect(checkinPreflight({ checkedIn: true, didCheckedIn: true, credits: 5, enabled: true })).toMatchObject({ action: 'skip', state: 'claimed' })
    expect(checkinPreflight({ checkedIn: false, didCheckedIn: true, credits: 5, enabled: true })).toMatchObject({ action: 'skip', state: 'device-used' })
    expect(checkinPreflight({ checkedIn: false, didCheckedIn: false, credits: 5, enabled: true })).toMatchObject({ action: 'claim' })
    expect(checkinPreflight({ checkedIn: false, didCheckedIn: false, credits: 5, enabled: false })).toMatchObject({ action: 'skip', state: 'unknown' })
  })

  it('maps the upstream 9095 refusal to device-used instead of a generic failure', () => {
    const after = { checkedIn: false, didCheckedIn: true, credits: 0, enabled: true }
    expect(checkinClaimOutcome({ claimed: false, code: 9095, message: '该设备今日已参与签到' }, after, 9095)).toMatchObject({
      state: 'device-used',
      claimed: false,
    })
    expect(checkinClaimOutcome({ claimed: true, code: 0, message: '' }, { ...after, checkedIn: true }, 9095)).toMatchObject({
      state: 'claimed',
      claimed: true,
    })
    expect(checkinClaimOutcome({ claimed: false, code: 9004, message: '参数错误' }, after, 9095)).toMatchObject({
      state: 'device-used',
      claimed: false,
    })
  })
})
