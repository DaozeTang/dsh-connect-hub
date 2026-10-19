import { describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../../../src/providers/workbuddy/catalog.ts'
import {
  PROBE_EFFORT_CANDIDATES,
  probeModel,
  type ProbeAttempt,
  type ProbeSender,
} from '../../../src/providers/workbuddy/probe.ts'
import { WorkBuddyProbeStore, fingerprintModel } from '../../../src/providers/workbuddy/probe-store.ts'
import { WorkBuddyProbeService } from '../../../src/providers/workbuddy/probe-service.ts'
import type { WorkBuddyCredentialSource } from '../../../src/providers/workbuddy/auth.ts'
import { FakePrefs } from './helpers.ts'

/**
 * Offline tests for the probe protocol. The point is the *gating*, not the
 * sweep: a model that answers 200 to a value that cannot exist must never
 * produce a per-level result, and anything non-decisive must degrade to
 * `unknown` rather than to a negative capability claim.
 */

const ACCEPTED: ProbeAttempt = { status: 200, streamed: true }
const REJECTED: ProbeAttempt = { status: 400, streamed: false, errorCode: 'invalid_reasoning_effort' }
const GLOBAL_REJECTED: ProbeAttempt = { status: 400, streamed: false, errorCode: 'model_param_invalid' }
const GLOBAL_REJECTED_RESPELT: ProbeAttempt = { status: 400, streamed: false, errorCode: 'invalid_parameter_value' }

function tableSender(table: Map<string | undefined, ProbeAttempt>): ProbeSender {
  return async (effort) => table.get(effort) ?? REJECTED
}

function counting(inner: ProbeSender): { send: ProbeSender, count: () => number } {
  let count = 0
  return {
    count: () => count,
    send: async (effort, signal) => {
      count += 1
      return inner(effort, signal)
    },
  }
}

const SENTINEL = 'probe_sentinel_test'

describe('probeModel', () => {
  it('verifies the levels a validating model accepts', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', REJECTED],
      ['high', ACCEPTED],
      ['xhigh', REJECTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'high', 'max'])
    expect(outcome.requests).toBe(2 + PROBE_EFFORT_CANDIDATES.length)
  })

  it('marks a model that accepts the sentinel as non-validating and stops early', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, ACCEPTED],
    ])
    const sent = counting(tableSender(table))
    const outcome = await probeModel({ send: sent.send, sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('non-validating')
    expect(outcome.efforts).toEqual([])
    expect(outcome.requests).toBe(2)
    expect(sent.count()).toBe(2)
  })

  it('reports unknown when the baseline fails', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, { status: 401, streamed: false, errorCode: 'unauthorized' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.requests).toBe(1)
  })

  it('reports unknown when the sentinel fails non-attributably', async () => {
    for (const attempt of [
      { status: 429, streamed: false, errorCode: 'rate_limited' },
      { status: 400, streamed: false, errorCode: 'something_else' },
      { status: 400, streamed: false },
    ] satisfies ProbeAttempt[]) {
      const table = new Map<string | undefined, ProbeAttempt>([
        [undefined, ACCEPTED],
        [SENTINEL, attempt],
      ])
      const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
      expect(outcome.validation).toBe('unknown')
      expect(outcome.requests).toBe(2)
    }
  })

  it('reads each region’s measured rejection vocabulary', async () => {
    for (const [region, attempt] of [
      ['cn', REJECTED],
      ['global', GLOBAL_REJECTED],
      ['global', GLOBAL_REJECTED_RESPELT],
    ] as const) {
      const table = new Map<string | undefined, ProbeAttempt>([
        [undefined, ACCEPTED],
        [SENTINEL, attempt],
        ['low', ACCEPTED],
        ['medium', REJECTED],
        ['high', ACCEPTED],
        ['xhigh', REJECTED],
        ['max', ACCEPTED],
      ])
      const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region })
      expect(outcome.validation).toBe('validating')
      expect(outcome.efforts).toEqual(['low', 'high', 'max'])
    }
  })

  it('reports the whole sweep unknown when a mid-sweep answer is non-decisive', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', { status: 500, streamed: false }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.efforts).toEqual([])
  })

  it('caps one attempt with a timeout and maps transport failures to unknown', async () => {
    const outcome = await probeModel({
      send: async () => {
        throw new Error('socket closed')
      },
      sentinel: () => SENTINEL,
      timeoutMs: 10,
    })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.validation === 'unknown' && outcome.reason).toContain('baseline')
  })
})

describe('fingerprintModel', () => {
  const base = { id: 'm', name: 'M', contextWindow: 1, maxTokens: 1, supportsImages: false }
  it('ignores display-only fields and covers the reasoning shape', () => {
    const a = fingerprintModel(base)
    expect(fingerprintModel({ ...base, name: 'Renamed', billing: { free: true } })).toBe(a)
    expect(
      fingerprintModel({ ...base, reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false } }),
    ).not.toBe(a)
  })
})

describe('WorkBuddyProbeStore', () => {
  const cred = { uid: 'uid-1', enterpriseId: 'ent-1' }
  function makeStore(): { prefs: FakePrefs, store: WorkBuddyProbeStore, now: { value: number } } {
    const prefs = new FakePrefs()
    const now = { value: 1_000 }
    const store = new WorkBuddyProbeStore({
      prefs,
      key: 'provider:workbuddy:probes',
      pluginVersion: 'test',
      now: () => now.value,
    })
    return { prefs, store, now }
  }

  it('round-trips a record per account and rejects fingerprint, TTL, and identity mismatches', async () => {
    const { store, now } = makeStore()
    await store.load()
    const fingerprint = fingerprintModel({ id: 'm', name: 'M', contextWindow: 1, maxTokens: 1, supportsImages: false })
    const account = `${cred.uid}:${cred.enterpriseId ?? ''}`
    await store.set('m', store.record(fingerprint, 'validating', ['low', 'high'], account))
    expect(store.get('m', fingerprint, account)).toMatchObject({ validation: 'validating', efforts: ['low', 'high'] })
    expect(store.get('m', 'other-fingerprint', account)).toBeUndefined()
    expect(store.get('m', fingerprint, 'other-account:')).toBeUndefined()
    now.value += 15 * 24 * 60 * 60 * 1000
    expect(store.get('m', fingerprint, account)).toBeUndefined()
  })

  it('does not let a transient unknown erase a paid-for decisive record', async () => {
    const { store } = makeStore()
    await store.load()
    const fingerprint = 'fp'
    await store.set('m', store.record(fingerprint, 'validating', ['low'], 'uid-1:'))
    await store.set('m', store.record(fingerprint, 'unknown', [], 'uid-1:'))
    expect(store.get('m', fingerprint, 'uid-1:')?.validation).toBe('validating')
  })

  it('persists through the preferences store and reloads', async () => {
    const { store, prefs, now } = makeStore()
    await store.load()
    await store.set('m', store.record('fp', 'non-validating', [], 'uid-1:'))
    const reopened = new WorkBuddyProbeStore({
      prefs,
      key: 'provider:workbuddy:probes',
      pluginVersion: 'test',
      now: () => now.value,
    })
    await reopened.load()
    expect(reopened.get('m', 'fp', 'uid-1:')?.validation).toBe('non-validating')
  })
})

describe('WorkBuddyProbeService', () => {
  function setup(consent = false, account: string | null = 'uid-1:ent-1'): {
    service: WorkBuddyProbeService
    send: ReturnType<typeof vi.fn>
    setAccount: (value: string | undefined) => void
  } {
    const prefs = new FakePrefs()
    const catalog = new WorkBuddyCatalog()
    const send = vi.fn(async (): Promise<ProbeAttempt> => ({ status: 200, streamed: true }))
    let currentAccount: string | undefined = account ?? undefined
    const credentials: WorkBuddyCredentialSource = {
      current: async () => ({
        accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 60_000,
        domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
      }),
      resolve: async () => ({
        accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 60_000,
        domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
      }),
    }
    const service = new WorkBuddyProbeService({
      catalog,
      store: new WorkBuddyProbeStore({ prefs, key: 'probes', pluginVersion: 'test' }),
      credentials,
      client: { probeEffort: async () => ({ status: 0, streamed: false }) },
      region: 'cn',
      consent: () => consent,
      account: () => currentAccount,
      send: () => send,
    })
    return {
      service,
      send,
      setAccount: (value) => {
        currentAccount = value
      },
    }
  }

  it('keeps automatic probes gated but permits one confirmed model without changing consent', async () => {
    const { service, send } = setup()
    expect((await service.probe('glm-5.2')).state).toBe('unavailable')
    expect(send).not.toHaveBeenCalled()
    expect((await service.probe('glm-5.2', true)).state).toBe('ok')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith(undefined, expect.anything())
    expect((await service.probe('hy3')).state).toBe('unavailable')
  })

  it('does not spend twice when two callers submit the same model', async () => {
    const { service, send } = setup()
    const results = await Promise.all([service.probe('glm-5.2', true), service.probe('glm-5.2', true)])
    expect(results.map((result) => result.state)).toEqual(['ok', 'ok'])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not let a new account join the previous account’s pending probe', async () => {
    const { service, send, setAccount } = setup(false, 'uid-a:ent-1')
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    send.mockImplementationOnce(async () => {
      await gate
      return { status: 200, streamed: true }
    })
    const probeA = service.probe('glm-5.2', true)
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1)
    })
    setAccount('uid-b:ent-1')
    const probeB = service.probe('glm-5.2', true)
    release()
    await expect(probeA).resolves.toMatchObject({ state: 'unavailable', reason: 'account changed during detection' })
    await expect(probeB).resolves.toMatchObject({ state: 'ok' })
  })

  it('reuses a decisive historical result only for authorized automatic probes', async () => {
    const { service, send } = setup(true)
    await service.probe('glm-5.2', true)
    expect(await service.probe('glm-5.2')).toMatchObject({ state: 'ok', requests: 0 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('rejects declared and unknown models before sending', async () => {
    const { service, send } = setup()
    expect((await service.probe('glm-5.3-flash', true)).state).toBe('unavailable')
    expect((await service.probe('not-in-catalog', true)).state).toBe('unavailable')
    expect(send).not.toHaveBeenCalled()
  })

  it('reports no credential when signed out', async () => {
    const { service } = setup(false, null)
    expect(await service.probe('glm-5.2', true)).toMatchObject({ state: 'unavailable', reason: 'no WorkBuddy credential' })
  })
})
