/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
 * shim applies the WorkBuddy wire quirks (forced streaming, string
 * `tool_choice`, CLI-shaped headers) and forwards to the real upstream.
 * It binds 127.0.0.1 only and never serves another interface.
 *
 * Inbound hardening matches the Qoder shim: loopback Host/Origin, JSON-only
 * chat POSTs, and the per-process bearer secret (the loopback bind alone is
 * not a trust boundary).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WorkBuddyCredentialSource } from './auth.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { extractDisplayErrorMessage, prepareChatBody, type UpstreamErrorKind } from './upstream.ts'

/** Minimal logger surface the shim needs; the hub logger satisfies it. */
export interface ShimLogger {
  warn(message: string): void
  error(message: string): void
}

/** The upstream chat surface the shim needs. */
export interface ShimChatSource {
  chatStream(
    credential: Awaited<ReturnType<WorkBuddyCredentialSource['resolve']>>,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; response: Response }
    | { ok: false; status: number; kind: UpstreamErrorKind; message: string }
  >
}

/** What the plugin needs from a running shim. */
export interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself via the store.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface WorkBuddyShimOptions {
  store: Pick<WorkBuddyCredentialSource, 'resolve'>
  client: ShimChatSource
  catalog: Pick<WorkBuddyCatalog, 'current'>
  logger?: ShimLogger
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Start the loopback endpoint. Requests carry the shim's own bearer; the
 * upstream credential comes from the credential source alone.
 */
export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { store, client, catalog } = options
  const logger = options.logger

  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const a = Buffer.from(presented)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('workbuddy shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map((model) => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'workbuddy',
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) writeOpenAIError(res, 500, 'internal', errorText(error))
      else res.end()
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    let credential
    try {
      credential = await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', errorText(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const result = await client.chatStream(credential, prepared, controller.signal)

    if (!result.ok) {
      const detail = extractDisplayErrorMessage(result.message) ?? result.message.slice(0, 400)
      // The host adapter classifies any error text containing a bare `401`/`403`
      // word as AUTH, which would mask business errors behind an "invalid API
      // key" banner. Only session failures keep the status note — every 401
      // classifies as session_dead, so genuine auth errors stay recognisable.
      const statusNote =
        (result.status === 401 || result.status === 403) && result.kind !== 'session_dead'
          ? ''
          : ` (http ${result.status})`
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        `workbuddy upstream ${result.kind}${statusNote}: ${detail}`,
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      if (chunk.includes('[DONE]')) sawDone = true
    })
    body.on('error', (error: unknown) => {
      logger?.warn(`dsh-connect-hub: workbuddy upstream stream failed mid-flight: ${errorText(error)}`)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => resolve())
        server.closeAllConnections()
        server.once('error', reject)
      }),
  }
}
