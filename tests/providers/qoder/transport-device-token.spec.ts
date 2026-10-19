/**
 * Direct device-token transport: a desktop-imported token is already the job
 * token, so it must skip the PAT exchange and only resolve the account identity.
 */
import { describe, expect, it, vi } from 'vitest'
import { createQoderTransport } from '../../../src/providers/qoder/qoder/transport/index.ts'
import { QoderAuthService } from '../../../src/providers/qoder/qoder/transport/auth.ts'
import { captureFetch, json } from './fakes.ts'

const MODEL_LIST_PAYLOAD = {
  assistant: [
    {
      key: 'cmodel',
      display_name: 'Cantus (Qoder)',
      enable: true,
      max_input_tokens: 1_000_000,
      max_output_tokens: 32_768,
    },
  ],
}

const USERINFO_URL = 'https://openapi.qoder.com.cn/api/v1/userinfo'
const MODELS_URL = 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1'
const EXCHANGE_URL = 'https://openapi.qoder.com.cn/api/v1/jobToken/exchange'

describe('device token transport', () => {
  it('resolves the identity and lists models without a PAT exchange', async () => {
    const { fetch: fetchImpl, requests } = captureFetch((url) => {
      if (url === USERINFO_URL) return json({ id: 'user-1', name: 'Tester', email: 'tester@example.com' })
      if (url === MODELS_URL) return json(MODEL_LIST_PAYLOAD)
      return undefined
    })
    const transport = createQoderTransport({
      region: 'china',
      resolveAccessToken: async () => 'dt-desktop-token',
      fetch: fetchImpl,
      resolveMachineId: () => 'machine-1',
    })

    const models = await transport.discoverModels()

    expect(models.map(model => model.id)).toEqual(['cmodel'])
    expect(requests.map(request => request.url)).toEqual([USERINFO_URL, MODELS_URL])
    expect(requests.some(request => request.url === EXCHANGE_URL)).toBe(false)
    expect(requests[0]!.headers['authorization']).toBe('Bearer dt-desktop-token')
    const modelList = requests[1]!
    expect(modelList.headers['authorization']).toMatch(/^Bearer COSY\./u)
    expect(modelList.headers['cosy-user']).toBe('user-1')
    // The raw device token must never travel as a plain bearer on the gateway.
    expect(JSON.stringify(modelList.headers)).not.toContain('dt-desktop-token')
  })

  it('caches the identity lookup across calls', async () => {
    const { fetch: fetchImpl, requests } = captureFetch((url) => {
      if (url === USERINFO_URL) return json({ id: 'user-1', name: 'Tester' })
      if (url === MODELS_URL) return json(MODEL_LIST_PAYLOAD)
      return undefined
    })
    const transport = createQoderTransport({
      region: 'china',
      resolveAccessToken: async () => 'dt-desktop-token',
      fetch: fetchImpl,
    })
    await transport.discoverModels()
    await transport.discoverModels()
    expect(requests.filter(request => request.url === USERINFO_URL)).toHaveLength(1)
  })

  it('rotates a rejected device token on the usage read and retries', async () => {
    const userinfoAuth: string[] = []
    let usageCalls = 0
    let refreshCalls = 0
    const { fetch: fetchImpl } = captureFetch((url, request) => {
      if (url === USERINFO_URL) {
        userinfoAuth.push(request.headers['authorization'] ?? '')
        return json({ id: 'user-1', name: 'Tester' })
      }
      if (url.includes('/api/v2/quota/usage')) {
        usageCalls += 1
        return usageCalls === 1 ? json({}, 401) : json({})
      }
      if (url.includes('/api/v2/user/plan') || url.includes('/api/v3/user/status')) {
        return json({}, 404)
      }
      return undefined
    })
    const transport = createQoderTransport({
      region: 'china',
      resolveAccessToken: async () => 'dt-old',
      refreshDeviceToken: async () => {
        refreshCalls += 1
        return 'dt-new'
      },
      fetch: fetchImpl,
    })
    const account = await transport.readAccount()
    expect(account.profile.id).toBe('user-1')
    expect(refreshCalls).toBe(1)
    expect(userinfoAuth).toEqual(['Bearer dt-old', 'Bearer dt-new'])
    expect(usageCalls).toBe(2)
  })

  it('keeps the PAT exchange path for pt- credentials', async () => {
    const { fetch: fetchImpl, requests } = captureFetch((url) => {
      if (url === EXCHANGE_URL) return json({ token: 'jt-exchanged', expires_in: 3_600_000 })
      if (url === USERINFO_URL) return json({ id: 'user-1', name: 'Tester' })
      if (url === MODELS_URL) return json(MODEL_LIST_PAYLOAD)
      return undefined
    })
    const transport = createQoderTransport({
      region: 'china',
      resolveAccessToken: async () => 'pt-personal-token',
      fetch: fetchImpl,
    })
    const models = await transport.discoverModels()
    expect(models.map(model => model.id)).toEqual(['cmodel'])
    expect(requests[0]!.url).toBe(EXCHANGE_URL)
    expect(requests.some(request => request.url === USERINFO_URL)).toBe(true)
  })
})

describe('QoderAuthService device rotation', () => {
  it('rotates through the store callback on a self-heal and resolves the new token', async () => {
    const seen: string[] = []
    const { fetch: fetchImpl } = captureFetch((url, request) => {
      if (url === USERINFO_URL) {
        seen.push(request.headers['authorization'] ?? '')
        return json({ id: 'user-1', name: 'Tester' })
      }
      return undefined
    })
    const service = new QoderAuthService({
      fetch: fetchImpl,
      region: 'china',
      resolveMachineId: () => 'machine-1',
      refreshDeviceToken: async () => 'dt-rotated',
    })
    const before = await service.getCredentials('dt-initial')
    const healed = await service.exchangeFresh('dt-initial')
    expect(before.authToken).toBe('dt-initial')
    expect(healed.authToken).toBe('dt-rotated')
    expect(seen).toEqual(['Bearer dt-initial', 'Bearer dt-rotated'])
  })

  it('fails the self-heal honestly when no rotation callback is wired', async () => {
    const { fetch: fetchImpl } = captureFetch((url) => {
      if (url === USERINFO_URL) return json({ id: 'user-1' })
      return undefined
    })
    const service = new QoderAuthService({ fetch: fetchImpl, region: 'china', resolveMachineId: () => 'm' })
    await expect(service.exchangeFresh('dt-initial')).rejects.toThrow(/cannot be rotated/u)
  })

  it('shares one identity lookup between concurrent device-token readers', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls = vi.fn()
    const fetchImpl = (async () => {
      calls()
      await gate
      return json({ id: 'user-1', name: 'Tester' })
    }) as typeof fetch
    const service = new QoderAuthService({ fetch: fetchImpl, region: 'china', resolveMachineId: () => 'm' })
    const first = service.getCredentials('dt-initial')
    const second = service.getCredentials('dt-initial')
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a.authToken).toBe('dt-initial')
    expect(b.authToken).toBe('dt-initial')
    expect(calls).toHaveBeenCalledTimes(1)
  })
})
