/**
 * Host entry wiring: route registration, loopback/Host enforcement, the
 * key-gated action surface, ProviderActionError mapping, and dispose ordering.
 *
 * No real DSH host: a fake Cordis context records registrations and the route
 * handler is driven directly with fake request/response objects.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply } from '../src/index.ts'

interface FakeState {
  route: WebRoute | undefined
  routeDisposers: (() => void)[]
  lifecycleDisposers: (() => unknown)[]
  directoryRegistrations: number
  adapterRegistrations: string[][]
  origin: string
  port: number
}

function makeContext(state: FakeState): never {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    emit: () => {},
    effect: (fn: () => unknown) => {
      const dispose = fn()
      if (typeof dispose === 'function') state.lifecycleDisposers.push(dispose as () => unknown)
    },
    inject: (deps: readonly string[], fn: (scope: unknown) => void) => {
      if (!deps.includes('webServer')) return
      fn({
        webServer: {
          getOrigin: () => state.origin,
          port: state.port,
          register: (route: WebRoute) => {
            state.route = route
            return () => { state.route = undefined }
          },
        },
        effect: (effect: () => unknown) => {
          const dispose = effect()
          if (typeof dispose === 'function') state.routeDisposers.push(dispose as () => void)
        },
      })
    },
    llm: {
      registerAdapter: (providers: string[]) => {
        state.adapterRegistrations.push([...providers])
        const handle = () => {}
        return Object.assign(handle, { replace: () => {} })
      },
      registerConfigurableProviders: () => {
        state.directoryRegistrations += 1
        return () => {}
      },
    },
  }
  return ctx as never
}

interface FakeResponse {
  status: number
  body: string
  headers: Record<string, string>
}

function request(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1', remotePort: 40_000 },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

function response(): { res: ServerResponse, result: FakeResponse } {
  const result: FakeResponse = { status: 0, body: '', headers: {} }
  const res = {
    headersSent: false,
    writeHead: (status: number, headers: Record<string, string>) => {
      result.status = status
      result.headers = headers
      ;(res as unknown as { headersSent: boolean }).headersSent = true
    },
    end: (chunk?: string) => { if (chunk !== undefined) result.body += chunk },
    destroy: () => {},
  } as unknown as ServerResponse
  return { res, result }
}

async function dispatch(
  route: WebRoute,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<FakeResponse> {
  const { res, result } = response()
  await route.handler(request(method, url, headers, body), res)
  return result
}

let cleanup: string | undefined
afterEach(async () => {
  vi.unstubAllEnvs()
  if (cleanup !== undefined) {
    await rm(cleanup, { recursive: true, force: true })
    cleanup = undefined
  }
})

describe('host entry', () => {
  it('registers the loopback route and enforces the key on actions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hub-index-'))
    cleanup = dataDir
    vi.stubEnv('DSH_CONNECT_HUB_DATA_DIR', join(dataDir, 'data'))
    // Point HOME at the disposable directory too, so provider discovery never
    // reads the real user profile.
    vi.stubEnv('HOME', dataDir)
    vi.stubEnv('USERPROFILE', dataDir)

    const state: FakeState = {
      route: undefined,
      routeDisposers: [],
      lifecycleDisposers: [],
      directoryRegistrations: 0,
      adapterRegistrations: [],
      origin: 'http://127.0.0.1:4321',
      port: 4321,
    }
    await apply(makeContext(state))
    const route = state.route
    expect(route).toBeDefined()
    expect(route).toMatchObject({ kind: 'prefix', path: '/plugins/dsh-connect-hub' })

    const status = await dispatch(route!, 'GET', '/plugins/dsh-connect-hub/status', { host: '127.0.0.1:4321' })
    expect(status.status).toBe(200)
    const document = JSON.parse(status.body) as {
      version: string
      key: string
      providers: { id: string }[]
      warnings: unknown[]
    }
    expect(document.version).toBe('0.0.0-test')
    expect(document.key).toMatch(/^[0-9a-f]{48}$/u)
    expect(document.providers.map(provider => provider.id)).toEqual([
      'qoder', 'qoder-global', 'workbuddy', 'workbuddy-ai', 'trae', 'trae-global',
    ])

    // No key: the action route is rejected before dispatch.
    const denied = await dispatch(route!, 'POST', '/plugins/dsh-connect-hub/action', {
      host: '127.0.0.1:4321',
      'content-type': 'application/json',
    }, JSON.stringify({ type: 'refresh-status' }))
    expect(denied.status).toBe(401)

    // Key present but an invalid action: rejected by the parser.
    const invalid = await dispatch(route!, 'POST', '/plugins/dsh-connect-hub/action', {
      host: '127.0.0.1:4321',
      'content-type': 'application/json',
      'x-hub-key': document.key,
    }, JSON.stringify({ type: 'refresh-usage', provider: 'missing' }))
    expect(invalid.status).toBe(400)
    expect(JSON.parse(invalid.body)).toMatchObject({ error: 'invalid_action' })

    // A real provider action failure maps to a stable code plus a redacted detail.
    const failed = await dispatch(route!, 'POST', '/plugins/dsh-connect-hub/action', {
      host: '127.0.0.1:4321',
      'content-type': 'application/json',
      'x-hub-key': document.key,
    }, JSON.stringify({ type: 'refresh-usage', provider: 'qoder' }))
    const failure = JSON.parse(failed.body) as { ok: boolean, error: string, detail?: string }
    expect(failure).toMatchObject({ ok: false, error: 'not_configured' })
    expect(failure.detail).toContain('尚未登录 Qoder')

    // A non-allowed Host is refused for a real (non-synthetic) request.
    const foreignHost = await dispatch(route!, 'GET', '/plugins/dsh-connect-hub/status', { host: 'evil.example' })
    expect(foreignHost.status).toBe(403)

    const notFound = await dispatch(route!, 'GET', '/plugins/dsh-connect-hub/nope', { host: '127.0.0.1:4321' })
    expect(notFound.status).toBe(404)

    // Let provider init settle: Qoder and Trae register a settings directory
    // entry (two regions each); all six runtimes register an adapter.
    await vi.waitFor(() => { expect(state.directoryRegistrations).toBe(4) }, { timeout: 10_000 })
    expect(state.adapterRegistrations).toHaveLength(6)
    for (const dispose of state.lifecycleDisposers) await dispose()
    for (const dispose of state.routeDisposers) dispose()
    expect(state.route).toBeUndefined()
  }, 20_000)

  it('resolves with adapters registered in a composition without a web server (headless/TUI)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hub-headless-'))
    cleanup = dataDir
    vi.stubEnv('DSH_CONNECT_HUB_DATA_DIR', join(dataDir, 'data'))
    vi.stubEnv('HOME', dataDir)
    vi.stubEnv('USERPROFILE', dataDir)
    const state: FakeState = {
      route: undefined,
      routeDisposers: [],
      lifecycleDisposers: [],
      directoryRegistrations: 0,
      adapterRegistrations: [],
      origin: 'http://127.0.0.1:4321',
      port: 4321,
    }
    const ctx = makeContext(state) as unknown as { inject: unknown }
    ctx.inject = () => { /* no webServer service in a headless composition */ }
    await apply(ctx as never)
    expect(state.route).toBeUndefined()
    const providers = state.adapterRegistrations.flat()
    expect(providers).toHaveLength(6)
    expect(new Set(providers)).toEqual(new Set([
      'qoder', 'qoder-global', 'workbuddy', 'workbuddy-ai', 'trae', 'trae-global',
    ]))
    for (const dispose of state.lifecycleDisposers) await dispose()
  })
})
