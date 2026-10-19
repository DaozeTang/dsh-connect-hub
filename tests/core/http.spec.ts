import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHubRoute } from '../../src/core/http.ts'
import type { HubAction, HubStatus } from '../../src/shared/contracts.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

const KEY = 'test-key'
const servers: ReturnType<typeof createServer>[] = []

function silentLog() {
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log }
  return log
}

function status(): HubStatus {
  return { version: '0.0.0-test', revision: 1, now: 1, key: KEY, warnings: [], providers: [] }
}

async function serve(): Promise<{ base: string; host: string; dispatch: ReturnType<typeof vi.fn> }> {
  const dispatch = vi.fn(async (_action: HubAction) => ({ ok: true as const }))
  const route: WebRoute = createHubRoute({
    basePath: '/plugins/dsh-connect-hub',
    key: KEY,
    buildStatus: status,
    dispatch,
    allowedHosts: () => [host],
    log: silentLog() as never,
  })
  const server = createServer((req, res) => { void route.handler(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const host = `127.0.0.1:${port}`
  return { base: `http://${host}`, host, dispatch }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

describe('hub HTTP route', () => {
  it('serves the status document with the control key', async () => {
    const { base } = await serve()
    const response = await fetch(`${base}/plugins/dsh-connect-hub/status`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ key: KEY, providers: [] })
  })

  it('refuses an action without the key', async () => {
    const { base, dispatch } = await serve()
    const response = await fetch(`${base}/plugins/dsh-connect-hub/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'refresh-status' }),
    })
    expect(response.status).toBe(401)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches a valid action with the key and attaches fresh status', async () => {
    const { base, dispatch } = await serve()
    const response = await fetch(`${base}/plugins/dsh-connect-hub/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY },
      body: JSON.stringify({ type: 'refresh-catalog', provider: 'qoder' }),
    })
    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledWith({ type: 'refresh-catalog', provider: 'qoder' })
    expect(await response.json()).toMatchObject({ ok: true, status: { key: KEY } })
  })

  it('rejects a cross-origin request', async () => {
    const { base, host } = await serve()
    const response = await fetch(`${base}/plugins/dsh-connect-hub/status`, {
      headers: { origin: 'https://evil.example' },
    })
    expect(response.status).toBe(403)
    expect(host).toContain('127.0.0.1')
  })

  it('accepts the same-origin Origin header', async () => {
    const { base } = await serve()
    const response = await fetch(`${base}/plugins/dsh-connect-hub/status`, {
      headers: { origin: base },
    })
    expect(response.status).toBe(200)
  })

  it('rejects malformed and oversized bodies', async () => {
    const { base } = await serve()
    const malformed = await fetch(`${base}/plugins/dsh-connect-hub/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY },
      body: '{oops',
    })
    expect(malformed.status).toBe(400)
    const unknown = await fetch(`${base}/plugins/dsh-connect-hub/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY },
      body: JSON.stringify({ type: 'delete-everything', provider: 'qoder' }),
    })
    expect(unknown.status).toBe(400)
    const huge = 'x'.repeat(300 * 1024)
    const oversized = await fetch(`${base}/plugins/dsh-connect-hub/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-key': KEY },
      body: JSON.stringify({ type: 'transfer-import', provider: 'trae', text: huge, accountIds: [] }),
    }).catch(() => undefined)
    expect(oversized === undefined || oversized.status === 400).toBe(true)
  })

  it('answers 404 outside its own namespace', async () => {
    const { base } = await serve()
    const response = await fetch(`${base}/plugins/dsh-connect-hub/other`)
    expect(response.status).toBe(404)
  })
})
