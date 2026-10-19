/**
 * Adversarial HTTP-route tests for the hub's single same-origin surface.
 *
 * These complement tests/core/http.spec.ts with attacker-shaped requests:
 * foreign Host/Origin, wrong/missing control keys, oversized and malformed
 * bodies, prototype-pollution payloads, path traversal, and the rate limiter.
 */
import { createServer, request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHubRoute } from '../../src/core/http.ts'
import type { HubAction, HubStatus } from '../../src/shared/contracts.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

const KEY = 'a'.repeat(48)
const BASE = '/plugins/dsh-connect-hub'
const servers: ReturnType<typeof createServer>[] = []

function silentLog() {
  const lines: string[] = []
  const log = {
    info: (message: string) => { lines.push(`info ${message}`) },
    warn: (message: string) => { lines.push(`warn ${message}`) },
    error: (message: string) => { lines.push(`error ${message}`) },
    child: () => log,
  }
  return { log, lines }
}

function statusDocument(): HubStatus {
  return { version: '0.0.0-test', revision: 3, now: 1, key: KEY, warnings: [], providers: [] }
}

interface Served {
  port: number
  host: string
  dispatch: ReturnType<typeof vi.fn>
  logLines: string[]
}

async function serve(dispatchImpl?: (action: HubAction) => Promise<unknown>): Promise<Served> {
  const { log, lines } = silentLog()
  const dispatch = vi.fn(dispatchImpl ?? (async (_action: HubAction) => ({ ok: true as const })))
  const route: WebRoute = createHubRoute({
    basePath: BASE,
    key: KEY,
    buildStatus: statusDocument,
    dispatch: dispatch as unknown as (action: HubAction) => Promise<{ ok: true }>,
    allowedHosts: () => {
      const port = (servers.at(-1)?.address() as AddressInfo | null)?.port
      return port === undefined ? [] : [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
    },
    log: log as never,
  })
  const server = createServer((req, res) => { void route.handler(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { port, host: `127.0.0.1:${port}`, dispatch, logLines: lines }
}

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function rawRequest(options: {
  port: number
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string | Buffer
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: options.port,
      method: options.method ?? 'GET',
      path: options.path ?? `${BASE}/status`,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

describe('HTTP route hardening', () => {
  it('rejects a foreign Host header (DNS rebinding) before anything else', async () => {
    const { port } = await serve()
    const response = await rawRequest({ port, headers: { host: `evil.example:${port}` } })
    expect(response.status).toBe(403)
    expect(response.body).not.toContain(KEY)
  })

  it('rejects a cross-origin request on both endpoints', async () => {
    const { port, dispatch } = await serve()
    const status = await rawRequest({ port, headers: { origin: 'https://evil.example' } })
    expect(status.status).toBe(403)
    const action = await rawRequest({
      port,
      method: 'POST',
      path: `${BASE}/action`,
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY, origin: 'https://evil.example' },
      body: JSON.stringify({ type: 'refresh-catalog', provider: 'qoder' }),
    })
    expect(action.status).toBe(403)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('accepts the genuine same-origin browser request', async () => {
    const { port, dispatch } = await serve()
    const origin = `http://127.0.0.1:${port}`
    const action = await rawRequest({
      port,
      method: 'POST',
      path: `${BASE}/action`,
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY, origin },
      body: JSON.stringify({ type: 'refresh-usage', provider: 'trae' }),
    })
    expect(action.status).toBe(200)
    expect(dispatch).toHaveBeenCalledWith({ type: 'refresh-usage', provider: 'trae' })
  })

  it('requires the control key on POST and compares it exactly', async () => {
    const { port, dispatch } = await serve()
    const post = (headers: Record<string, string>) => rawRequest({
      port,
      method: 'POST',
      path: `${BASE}/action`,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ type: 'refresh-catalog', provider: 'qoder' }),
    })
    expect((await post({})).status).toBe(401)
    expect((await post({ 'x-hub-key': 'short' })).status).toBe(401)
    expect((await post({ 'x-hub-key': 'a'.repeat(47) + 'b' })).status).toBe(401)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('serves GET status without the key by design, but adds no CORS allowance', async () => {
    const { port } = await serve()
    const response = await rawRequest({ port })
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    // A hostile page must not be able to read this cross-origin.
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rejects non-JSON content types and malformed JSON', async () => {
    const { port } = await serve()
    const wrongType = await rawRequest({
      port,
      method: 'POST',
      path: `${BASE}/action`,
      headers: { 'content-type': 'text/plain', 'x-hub-key': KEY },
      body: '{"type":"refresh-status"}',
    })
    expect(wrongType.status).toBe(400)
    const malformed = await rawRequest({
      port,
      method: 'POST',
      path: `${BASE}/action`,
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY },
      body: '{not json',
    })
    expect(malformed.status).toBe(400)
  })

  it('rejects a body above the 256 KiB cap', async () => {
    const { port, dispatch } = await serve()
    const response = await rawRequest({
      port,
      method: 'POST',
      path: `${BASE}/action`,
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY },
      body: JSON.stringify({ type: 'transfer-preview', provider: 'trae', text: 'x'.repeat(300 * 1024) }),
    })
    expect(response.status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('validates action fields before dispatch', async () => {
    const { port, dispatch } = await serve()
    const post = (body: unknown) => rawRequest({
      port,
      method: 'POST',
      path: `${BASE}/action`,
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY },
      body: JSON.stringify(body),
    })
    expect((await post({ type: 'save-secret', provider: 'qoder', secret: 'x'.repeat(5000) })).status).toBe(400)
    expect((await post({ type: 'refresh-catalog', provider: 'unknown-provider' })).status).toBe(400)
    expect((await post({ type: 'set-models-enabled', provider: 'qoder', modelIds: 'not-an-array', enabled: true })).status).toBe(400)
    expect((await post({ type: 'set-checkin', provider: 'qoder', minute: 1.5 })).status).toBe(400)
    expect((await post({ type: 'transfer-import', provider: 'trae', text: '[]', accountIds: ['x'.repeat(201)] })).status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not let a JSON payload pollute Object.prototype', async () => {
    const { port, dispatch } = await serve()
    const payload = JSON.stringify({
      type: 'save-secret',
      provider: 'qoder',
      secret: 'pat-test',
      __proto__: { polluted: true },
      constructor: { prototype: { polluted: true } },
    })
    const response = await rawRequest({
      port,
      method: 'POST',
      path: `${BASE}/action`,
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY },
      body: payload,
    })
    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    const delivered = dispatch.mock.calls[0]?.[0] as HubAction
    expect(delivered.type).toBe('save-secret')
    expect(Object.getPrototypeOf(delivered)).toBe(Object.prototype)
  })

  it('does not leak internal error text when dispatch throws', async () => {
    const { port } = await serve(async () => {
      throw new Error('SECRET-LIKE-FAILURE-TOKEN-abcdefghijklmnop')
    })
    const response = await rawRequest({
      port,
      method: 'POST',
      path: `${BASE}/action`,
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY },
      body: JSON.stringify({ type: 'refresh-catalog', provider: 'qoder' }),
    })
    expect(response.status).toBe(500)
    expect(response.body).not.toContain('SECRET-LIKE-FAILURE-TOKEN')
    expect(JSON.parse(response.body)).toEqual({ error: 'internal_error' })
  })

  it('serves nothing for path traversal spellings or unknown routes', async () => {
    const { port } = await serve()
    for (const path of [
      `${BASE}/status/../../../etc/passwd`,
      `${BASE}/status%2f..%2f..%2fetc%2fpasswd`,
      `${BASE}/..%2f..%2fpackage.json`,
      `/plugins/../package.json`,
    ]) {
      const response = await rawRequest({ port, path })
      expect([403, 404]).toContain(response.status)
      expect(response.body).not.toContain('"dsh-connect-hub"')
    }
  })

  it('throttles request floods per source address', async () => {
    const { port } = await serve()
    let last: RawResponse | undefined
    for (let index = 0; index < 181; index++) {
      last = await rawRequest({ port })
      if (index < 180) expect(last.status).toBe(200)
    }
    expect(last?.status).toBe(403)
  })
})

describe('peer-address gate (non-loopback deployment)', () => {
  interface FakeResponse {
    status: number
    headersSent: boolean
    body: string
    writeHead(status: number): void
    end(payload?: string): void
    destroy(): void
  }

  async function callHandler(
    requestLike: {
      method: string
      url: string
      headers: Record<string, string>
      socket: { remoteAddress?: string } | undefined
    },
  ): Promise<FakeResponse> {
    const route: WebRoute = createHubRoute({
      basePath: BASE,
      key: KEY,
      buildStatus: statusDocument,
      dispatch: async () => ({ ok: true }),
      allowedHosts: () => ['127.0.0.1:1234'],
      log: silentLog().log as never,
    })
    const response: FakeResponse = {
      status: 200,
      headersSent: false,
      body: '',
      writeHead(status: number) { this.status = status; this.headersSent = true },
      end(payload?: string) { this.body = payload ?? '' },
      destroy() {},
    }
    await route.handler(requestLike as never, response as never)
    return response
  }

  it('rejects a genuinely remote peer even with a valid loopback Host header', async () => {
    const response = await callHandler({
      method: 'GET',
      url: `${BASE}/status`,
      headers: { host: '127.0.0.1:1234' },
      socket: { remoteAddress: '203.0.113.9' },
    })
    expect(response.status).toBe(403)
    expect(response.body).not.toContain(KEY)
  })

  it('rejects a remote peer on POST /action before the key is even considered', async () => {
    let dispatched = false
    const route: WebRoute = createHubRoute({
      basePath: BASE,
      key: KEY,
      buildStatus: statusDocument,
      dispatch: async () => { dispatched = true; return { ok: true } },
      allowedHosts: () => ['127.0.0.1:1234'],
      log: silentLog().log as never,
    })
    const response: FakeResponse = {
      status: 200,
      headersSent: false,
      body: '',
      writeHead(status: number) { this.status = status; this.headersSent = true },
      end(payload?: string) { this.body = payload ?? '' },
      destroy() {},
    }
    await route.handler({
      method: 'POST',
      url: `${BASE}/action`,
      headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234', 'x-hub-key': KEY, 'content-type': 'application/json' },
      socket: { remoteAddress: '198.51.100.7' },
    } as never, response as never)
    expect(response.status).toBe(403)
    expect(dispatched).toBe(false)
  })

  it('allows loopback, its IPv4-mapped spelling, and the in-process browser bridge', async () => {
    const loopback = await callHandler({
      method: 'GET',
      url: `${BASE}/status`,
      headers: { host: '127.0.0.1:1234' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    expect(loopback.status).toBe(200)

    const mapped = await callHandler({
      method: 'GET',
      url: `${BASE}/status`,
      headers: { host: '127.0.0.1:1234' },
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    })
    expect(mapped.status).toBe(200)

    const synthetic = await callHandler({
      method: 'GET',
      url: `${BASE}/status`,
      headers: { host: '127.0.0.1:1234' },
      // The in-process browser bridge has a socket without a peer address.
      socket: {},
    })
    expect(synthetic.status).toBe(200)
  })

  it('allows a same-machine request that arrives over one of this host\'s own interface addresses', async () => {
    const own = Object.values(networkInterfaces())
      .flatMap(entries => entries ?? [])
      .map(entry => entry.address)
      .find(address => address !== '127.0.0.1' && address !== '::1')
    if (own === undefined) return
    const response = await callHandler({
      method: 'GET',
      url: `${BASE}/status`,
      headers: { host: '127.0.0.1:1234' },
      socket: { remoteAddress: own },
    })
    expect(response.status).toBe(200)
  })
})
