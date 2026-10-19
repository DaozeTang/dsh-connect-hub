import { describe, expect, it } from 'vitest'
import type { SecretSlot, Vault } from '../../../src/core/vault.ts'
import { QoderCredentialStore } from '../../../src/providers/qoder/credentials.ts'
import { QODER_CN_VARIANT, QODER_GLOBAL_VARIANT } from '../../../src/providers/qoder/variants.ts'
import { validateApiKey } from '../../../src/providers/qoder/upstream.ts'
import { captureFetch, json } from './fakes.ts'

const MODEL_LIST_PAYLOAD = {
  assistant: [
    {
      key: 'cmodel',
      display_name: 'Cantus (Qoder)',
      enable: true,
      max_input_tokens: 1_000_000,
      max_output_tokens: 32_768,
      is_vl: true,
    },
  ],
}

describe('validateApiKey', () => {
  it('exchanges the PAT and reads the user before accepting it (China region)', async () => {
    const { fetch: fetchImpl, requests } = captureFetch((url) => {
      if (url === 'https://openapi.qoder.com.cn/api/v1/jobToken/exchange') {
        return json({ token: 'job-token-cn', expires_in: 3600 })
      }
      if (url === 'https://openapi.qoder.com.cn/api/v1/userinfo') {
        return json({ id: 'user-1', name: 'Tester', email: 'tester@example.com' })
      }
      if (url === 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1') {
        return json(MODEL_LIST_PAYLOAD)
      }
      return undefined
    })

    await expect(validateApiKey('pat-cn-secret', 'china', { fetch: fetchImpl })).resolves.toBe(true)

    expect(requests.map(request => request.url)).toEqual([
      'https://openapi.qoder.com.cn/api/v1/jobToken/exchange',
      'https://openapi.qoder.com.cn/api/v1/userinfo',
      'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1',
    ])
    const exchange = requests[0]!
    expect(exchange.method).toBe('POST')
    expect(exchange.headers['content-type']).toBe('application/json')
    expect(JSON.parse(exchange.body ?? '{}')).toEqual({ personal_token: 'pat-cn-secret' })
    // The model-list request authenticates with the exchanged job token through
    // the signed COSY envelope, never with the raw PAT.
    const userInfo = requests[1]!
    expect(userInfo.headers['authorization']).toBe('Bearer job-token-cn')
    const modelList = requests[2]!
    expect(modelList.headers['authorization']).toMatch(/^Bearer COSY\./)
    expect(modelList.headers['authorization']).not.toContain('pat-cn-secret')
    expect(modelList.headers['cosy-user']).toBe('user-1')
  })

  it('uses the international endpoints for the global region', async () => {
    const { fetch: fetchImpl, requests } = captureFetch((url) => {
      if (url === 'https://openapi.qoder.sh/api/v1/jobToken/exchange') return json({ token: 'job-token-global' })
      if (url === 'https://openapi.qoder.sh/api/v1/userinfo') return json({ id: 'user-2' })
      if (url === 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1') return json(MODEL_LIST_PAYLOAD)
      return undefined
    })

    await expect(validateApiKey('pat-global', 'global', { fetch: fetchImpl })).resolves.toBe(true)
    expect(requests[0]!.url).toContain('openapi.qoder.sh')
    expect(requests[2]!.url).toContain('api3.qoder.sh')
  })

  it('rejects a token the region refuses', async () => {
    const { fetch: fetchImpl, requests } = captureFetch((url) => {
      if (url.endsWith('/jobToken/exchange')) return json({ error: 'invalid token' }, 401)
      return undefined
    })
    await expect(validateApiKey('revoked-pat', 'china', { fetch: fetchImpl })).resolves.toBe(false)
    expect(requests).toHaveLength(1)
  })

  it('refuses an empty token without touching the network', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return json({})
    }) as unknown as typeof fetch
    await expect(validateApiKey('   ', 'china', { fetch: fetchImpl })).resolves.toBe(false)
    expect(called).toBe(false)
  })
})

class MemoryVault {
  readonly slots = new Map<SecretSlot, unknown>()
  writes = 0

  async read<T>(slot: SecretSlot): Promise<T | undefined> {
    return this.slots.get(slot) as T | undefined
  }

  async write<T>(slot: SecretSlot, value: T): Promise<void> {
    this.writes += 1
    this.slots.set(slot, value)
  }

  async remove(slot: SecretSlot): Promise<void> {
    this.slots.delete(slot)
  }
}

describe('QoderCredentialStore', () => {
  it('reads each region token from its own vault slot', async () => {
    const vault = new MemoryVault()
    vault.slots.set('qoder-global', { version: 1, pat: 'vault-global-pat', savedAt: 5 })
    vault.slots.set('qoder-cn', { version: 1, pat: 'vault-cn-pat', savedAt: 7 })

    const cn = new QoderCredentialStore({ vault: vault as unknown as Vault, variant: QODER_CN_VARIANT })
    expect(await cn.load()).toMatchObject({ kind: 'pat', pat: 'vault-cn-pat' })
    expect(vault.writes).toBe(0)

    const global = new QoderCredentialStore({ vault: vault as unknown as Vault, variant: QODER_GLOBAL_VARIANT })
    expect(await global.load()).toMatchObject({ kind: 'pat', pat: 'vault-global-pat' })
  })

  it('saves, masks and clears the token through the vault only', async () => {
    const vault = new MemoryVault()
    const store = new QoderCredentialStore({ vault: vault as unknown as Vault, variant: QODER_CN_VARIANT })

    await store.load()
    expect(store.summary()).toEqual({ configured: false })
    await expect(store.accessToken()).rejects.toThrow(/MISSING_CREDENTIAL/)

    const saved = await store.savePat('  pat-saved-abcdef  ')
    expect(saved).toMatchObject({ kind: 'pat', pat: 'pat-saved-abcdef' })
    expect(store.summary()).toMatchObject({ configured: true, masked: '****cdef' })
    expect(store.identity()).toMatch(/^pat:[a-f0-9]{16}$/)
    await expect(store.accessToken()).resolves.toBe('pat-saved-abcdef')

    await store.clear()
    expect(store.summary()).toEqual({ configured: false })
    expect(vault.slots.has('qoder-cn')).toBe(false)
  })

  it('ignores a malformed stored payload and never writes over it on load', async () => {
    const vault = new MemoryVault()
    vault.slots.set('qoder-cn', { broken: true })
    const store = new QoderCredentialStore({ vault: vault as unknown as Vault, variant: QODER_CN_VARIANT })
    expect(await store.load()).toBeUndefined()
    expect(vault.writes).toBe(0)
  })
})
