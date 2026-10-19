/**
 * Adversarial loopback-shim tests for all three providers: bind address,
 * shared-secret strength, Host/Origin gates, bearer comparison, content-type
 * gate, and cleanup on close. No upstream network is touched: the chat source
 * is a fake.
 */
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createQoderShim } from '../../src/providers/qoder/shim.ts'
import { createWorkBuddyShim } from '../../src/providers/workbuddy/shim.ts'
import { createTraeShim } from '../../src/providers/trae/shim.ts'
import type { QoderShim } from '../../src/providers/qoder/shim.ts'
import type { WorkBuddyShim } from '../../src/providers/workbuddy/shim.ts'
import type { TraeShim } from '../../src/providers/trae/shim.ts'

interface ShimLike {
  ready: Promise<void>
  baseUrl(): string
  token(): string
  close(): Promise<void>
}

const open: ShimLike[] = []
afterEach(async () => {
  for (const shim of open.splice(0, open.length)) {
    await shim.close().catch(() => undefined)
  }
})

const SSE_BODY = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'

function fakeChatResult(): { ok: true, response: Response } {
  return {
    ok: true,
    response: new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }
}

async function startQoderShim(): Promise<QoderShim> {
  const shim = createQoderShim({
    store: { resolve: async () => ({ pat: 'pat-secret' }) } as never,
    client: { chatStream: async () => fakeChatResult() } as never,
    catalog: { current: () => [{ id: 'm1' }, { id: 'm2' }] } as never,
    providerId: 'qoder',
    logger: { warn: () => {}, error: () => {} },
  })
  await shim.ready
  open.push(shim)
  return shim
}

async function startWorkBuddyShim(): Promise<WorkBuddyShim> {
  const shim = createWorkBuddyShim({
    store: { resolve: async () => ({ accessToken: 'wb-access-token' }) } as never,
    client: { chatStream: async () => fakeChatResult() } as never,
    catalog: { current: () => [{ id: 'm1' }] } as never,
    logger: { warn: () => {}, error: () => {} },
  })
  await shim.ready
  open.push(shim)
  return shim
}

async function startTraeShim(): Promise<TraeShim> {
  const shim = createTraeShim({
    catalog: { current: () => [{ id: 'm1' }] } as never,
    client: { chatStream: async () => fakeChatResult() } as never,
    logger: { warn: () => {}, error: () => {} },
  })
  await shim.ready
  open.push(shim)
  return shim
}

interface RawResponse {
  status: number
  body: string
}

function requestShim(options: {
  base: string
  method?: string
  path: string
  headers?: Record<string, string>
  body?: string
}): Promise<RawResponse> {
  const url = new URL(options.base)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      method: options.method ?? 'GET',
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

const cases: { name: string, start: () => Promise<ShimLike> }[] = [
  { name: 'qoder', start: startQoderShim },
  { name: 'workbuddy', start: startWorkBuddyShim },
  { name: 'trae', start: startTraeShim },
]

describe.each(cases)('$name loopback shim', ({ start }) => {
  it('binds 127.0.0.1 only with a high-entropy per-instance secret', async () => {
    const first = await start()
    const second = await start()
    expect(new URL(first.baseUrl()).hostname).toBe('127.0.0.1')
    expect(first.token()).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(first.token()).not.toBe(second.token())
    // 32 random bytes in base64url = 43 characters.
    expect(first.token().length).toBeGreaterThanOrEqual(43)
  })

  it('rejects missing and wrong bearer tokens', async () => {
    const shim = await start()
    const base = shim.baseUrl()
    expect((await requestShim({ base, path: '/healthz' })).status).toBe(401)
    expect((await requestShim({ base, path: '/healthz', headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await requestShim({ base, path: '/v1/models' })).status).toBe(401)
  })

  it('rejects a foreign Host header even with the right bearer', async () => {
    const shim = await start()
    const response = await requestShim({
      base: shim.baseUrl(),
      path: '/healthz',
      headers: { authorization: `Bearer ${shim.token()}`, host: 'evil.example:4444' },
    })
    expect(response.status).toBe(403)
  })

  it('rejects a browser Origin that is not loopback, accepts a loopback one', async () => {
    const shim = await start()
    const base = shim.baseUrl()
    const auth = { authorization: `Bearer ${shim.token()}` }
    expect((await requestShim({ base, path: '/healthz', headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await requestShim({ base, path: '/healthz', headers: { ...auth, origin: 'null' } })).status).toBe(403)
    const allowed = await requestShim({ base, path: '/healthz', headers: { ...auth, origin: 'http://127.0.0.1:1234' } })
    expect(allowed.status).toBe(200)
  })

  it('serves the model list only to the authenticated plugin client', async () => {
    const shim = await start()
    const response = await requestShim({
      base: shim.baseUrl(),
      path: '/v1/models',
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(response.status).toBe(200)
    expect(response.body).toContain('"object":"list"')
  })

  it('enforces a JSON content type on chat POSTs', async () => {
    const shim = await start()
    const response = await requestShim({
      base: shim.baseUrl(),
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(response.status).toBe(415)
  })

  it('closes the listener on close() and tolerates a second close', async () => {
    const shim = await start()
    const index = open.indexOf(shim)
    if (index >= 0) open.splice(index, 1)
    const base = shim.baseUrl()
    await shim.close()
    await expect(requestShim({
      base,
      path: '/healthz',
      headers: { authorization: `Bearer ${shim.token()}` },
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    // Double dispose/teardown must resolve, never reject with ERR_SERVER_NOT_RUNNING.
    await expect(shim.close()).resolves.toBeUndefined()
  })
})
