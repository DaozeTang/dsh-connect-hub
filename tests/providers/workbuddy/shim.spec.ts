import { writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore } from '../../../src/providers/workbuddy/auth.ts'
import { WorkBuddyCatalog } from '../../../src/providers/workbuddy/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../../../src/providers/workbuddy/shim.ts'
import type { WorkBuddyChatResult } from '../../../src/providers/workbuddy/upstream.ts'
import { CN_VARIANT } from '../../../src/providers/workbuddy/variants.ts'
import { createTestDeps, type TestDeps } from './helpers.ts'

/**
 * Offline coverage of the loopback transport against 127.0.0.1 only: the
 * upstream is a fake, and no request leaves the machine. The tests exist to
 * pin the inbound hardening (bearer secret, loopback host/origin), the
 * normalized wire body, and the failure mapping.
 */

const CLEANUPS: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of CLEANUPS.splice(0)) await cleanup()
})

interface Harness {
  testDeps: TestDeps
  shim: WorkBuddyShim
  upstreamBodies: string[]
}

async function startShim(upstreamResponse: () => WorkBuddyChatResult): Promise<Harness> {
  const testDeps = await createTestDeps()
  const desktopPath = join(testDeps.paths.home, 'workbuddy.info')
  await writeFile(
    desktopPath,
    JSON.stringify({
      auth: {
        accessToken: 'shim-access-token',
        refreshToken: 'shim-refresh-token',
        expiresAt: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
      },
      account: { uid: 'uid-1' },
    }),
  )
  const store = new WorkBuddyCredentialStore({
    variant: CN_VARIANT,
    desktopPath,
    vault: testDeps.vault,
    slot: 'workbuddy-cn',
    refresh: async () => ({ accessToken: 'unused' }),
  })
  const catalog = new WorkBuddyCatalog()
  const harness: Harness = { testDeps, shim: undefined as unknown as WorkBuddyShim, upstreamBodies: [] }
  harness.shim = createWorkBuddyShim({
    store,
    catalog,
    client: {
      async chatStream(_credential, bodyJson): Promise<WorkBuddyChatResult> {
        harness.upstreamBodies.push(bodyJson)
        return upstreamResponse()
      },
    },
  })
  await harness.shim.ready
  CLEANUPS.push(async () => {
    await harness.shim.close()
    await testDeps.cleanup()
  })
  return harness
}

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function rawRequest(options: {
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function authorized(harness: Harness, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { authorization: `Bearer ${harness.shim.token()}`, ...init.headers },
  }
}

describe('WorkBuddy shim', () => {
  it('lists the CN catalog on /v1/models behind the per-process bearer', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const unauthorized = await fetch(`${harness.shim.baseUrl()}/v1/models`)
    expect(unauthorized.status).toBe(401)
    const response = await fetch(`${harness.shim.baseUrl()}/v1/models`, authorized(harness))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { id: string }[] }
    const ids = body.data.map((model) => model.id)
    expect(ids).toHaveLength(19)
    expect(ids).toContain('hy3')
    expect(ids).toContain('deepseek-v4-pro')
  })

  it('rejects a non-loopback Host and a cross-origin request', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const { port } = new URL(harness.shim.baseUrl())
    const badHost = await rawRequest({
      port: Number(port),
      method: 'GET',
      path: '/v1/models',
      headers: { host: 'evil.example', authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(badHost.status).toBe(403)
    const badOrigin = await fetch(`${harness.shim.baseUrl()}/v1/models`, {
      ...authorized(harness),
      headers: { ...authorized(harness).headers, origin: 'https://evil.example' },
    })
    expect(badOrigin.status).toBe(403)
  })

  it('streams a successful chat completion and normalizes the wire body', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(
      `${harness.shim.baseUrl()}/v1/chat/completions`,
      authorized(harness, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'hy3',
          stream: false,
          messages: [
            { role: 'developer', content: 'system prompt' },
            { role: 'user', content: 'hi' },
          ],
          tool_choice: { type: 'auto' },
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toContain('[DONE]')
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '{}') as {
      stream?: boolean
      messages?: { role: string }[]
      tool_choice?: string
    }
    expect(forwarded.stream).toBe(true)
    expect(forwarded.messages?.[0]?.role).toBe('system')
    expect(forwarded.tool_choice).toBe('auto')
  })

  it('maps an upstream failure onto a classified OpenAI error, never the token', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 402,
      kind: 'hard_credit',
      message: JSON.stringify({ displayMsg: { zh: '积分不足' } }),
    }))
    const response = await fetch(
      `${harness.shim.baseUrl()}/v1/chat/completions`,
      authorized(harness, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    expect(response.status).toBe(402)
    const body = (await response.json()) as { error: { type: string, message: string } }
    expect(body.error.type).toBe('hard_credit')
    expect(body.error.message).toContain('积分不足')
    expect(body.error.message).not.toContain('shim-access-token')
    expect(body.error.message).not.toContain('shim-refresh-token')
  })

  it('rejects a non-JSON chat body', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const response = await fetch(
      `${harness.shim.baseUrl()}/v1/chat/completions`,
      authorized(harness, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ model: 'hy3' }),
      }),
    )
    expect(response.status).toBe(415)
  })
})
