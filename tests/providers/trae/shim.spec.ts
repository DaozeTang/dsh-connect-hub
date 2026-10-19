import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { TraeCatalog } from '../../../src/providers/trae/catalog.ts'
import { createTraeShim, type TraeShim } from '../../../src/providers/trae/shim.ts'
import type { TraeUpstreamClient } from '../../../src/providers/trae/upstream.ts'

const cleanup: TraeShim[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(shim => shim.close()))
})

async function start(client?: TraeUpstreamClient): Promise<TraeShim> {
  const shim = createTraeShim({
    catalog: new TraeCatalog('cn'),
    client: client ?? {
      async chatStream() {
        return { ok: false, status: 503, kind: 'unconfigured', message: 'Trae upstream protocol is not configured' }
      },
    },
  })
  await shim.ready
  cleanup.push(shim)
  return shim
}

function raw(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: options.headers,
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

describe('Trae loopback shim', () => {
  it('binds an ephemeral loopback port with a per-process secret', async () => {
    const a = await start()
    const b = await start()
    expect(a.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(new URL(a.baseUrl()).port).not.toBe('0')
    expect(a.token()).not.toBe(b.token())
    expect(a.token().length).toBeGreaterThan(20)
  })

  it('serves models only with the bearer secret', async () => {
    const shim = await start()
    const authorized = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(authorized.status).toBe(200)
    const body = await authorized.json() as { object: string; data: { id: string }[] }
    expect(body.object).toBe('list')
    expect(body.data.map(item => item.id)).toContain('DeepSeek-V4-Flash-Official')

    const unauthorized = await fetch(`${shim.baseUrl()}/v1/models`)
    expect(unauthorized.status).toBe(401)
  })

  it('rejects a hostile Host and a hostile Origin', async () => {
    const shim = await start()
    const port = Number(new URL(shim.baseUrl()).port)
    const hostileHost = await raw(port, {
      path: '/healthz',
      headers: { host: 'evil.example', authorization: `Bearer ${shim.token()}` },
    })
    expect(hostileHost.status).toBe(403)
    const hostileOrigin = await raw(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        authorization: `Bearer ${shim.token()}`,
      },
      body: '{}',
    })
    expect(hostileOrigin.status).toBe(403)
  })

  it('rejects non-JSON chat requests and answers an unconfigured upstream explicitly', async () => {
    const shim = await start()
    const port = Number(new URL(shim.baseUrl()).port)
    const wrongType = await raw(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain', authorization: `Bearer ${shim.token()}` },
      body: '{}',
    })
    expect(wrongType.status).toBe(415)

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('not configured')
  })

  it('close() is idempotent for a double dispose', async () => {
    const shim = await start()
    const index = cleanup.indexOf(shim)
    if (index >= 0) cleanup.splice(index, 1)
    await shim.close()
    await expect(shim.close()).resolves.toBeUndefined()
    await expect(shim.close()).resolves.toBeUndefined()
  })

  it('healthz reports liveness behind the bearer', async () => {
    const shim = await start()
    const response = await fetch(`${shim.baseUrl()}/healthz`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
})
