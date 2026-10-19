import { timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { PROVIDER_IDS, type ActionResult, type HubAction, type HubStatus, type ProviderId } from '../shared/contracts.ts'
import type { HubLogger } from './log.ts'

const MAX_BODY_BYTES = 256 * 1024
const MAX_TEXT_LENGTH = 192 * 1024
const ROUTE_WINDOW_MS = 60_000
const ROUTE_LIMIT = 180

const ACTION_TYPES = new Set<HubAction['type']>([
  'refresh-status',
  'refresh-catalog',
  'refresh-usage',
  'refresh-account',
  'save-secret',
  'clear-secret',
  'import-desktop-login',
  'checkin',
  'set-checkin',
  'clear-checkin-log',
  'set-model-enabled',
  'set-models-enabled',
  'set-max-context',
  'select-account',
  'set-probe-consent',
  'probe-model',
  'test-models',
  'transfer-preview',
  'transfer-import',
  'transfer-export',
])

/** Own interface addresses, refreshed lazily: a same-machine peer may connect over a LAN literal. */
let ownAddresses: { at: number; values: Set<string> } | undefined

function localAddresses(): Set<string> {
  const now = Date.now()
  if (ownAddresses !== undefined && now - ownAddresses.at < 30_000) return ownAddresses.values
  const values = new Set<string>(['127.0.0.1', '::1'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address !== undefined) values.add(entry.address.toLowerCase())
    }
  }
  ownAddresses = { at: now, values }
  return values
}

function canonicalAddress(address: string): string {
  const lower = address.toLowerCase()
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower
}

/** The browser IPC bridge is in-process; a network request always carries a peer address. */
function isSyntheticRequest(req: IncomingMessage): boolean {
  return req.socket === undefined || req.socket.remoteAddress === undefined
}

function isLocalPeer(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address === undefined) return false
  const canonical = canonicalAddress(address.split('%')[0] as string)
  return canonical === '::1' || canonical.startsWith('127.') || localAddresses().has(canonical)
}

export interface HubRouteOptions {
  basePath: string
  key: string
  buildStatus: () => HubStatus
  dispatch: (action: HubAction) => Promise<Omit<ActionResult, 'status'>>
  allowedHosts: () => readonly string[]
  log: HubLogger
}

export function createHubRoute(options: HubRouteOptions): WebRoute {
  const key = Buffer.from(options.key)
  const hits = new Map<string, { count: number; resetAt: number }>()

  const allowed = (req: IncomingMessage): boolean => {
    if (isSyntheticRequest(req)) return true
    if (!isLocalPeer(req)) return false
    const host = req.headers.host
    if (host === undefined || !options.allowedHosts().includes(host)) return false
    const origin = req.headers.origin
    if (origin === undefined) return true
    // An Electron renderer loads the shell from file://; its bridged fetches
    // may carry `Origin: null`. Network peers never reach this branch.
    if (origin === 'null') return true
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  const withinRate = (req: IncomingMessage): boolean => {
    const address = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    if (hits.size > 1024) {
      for (const [key, value] of hits) if (now >= value.resetAt) hits.delete(key)
    }
    const entry = hits.get(address)
    if (entry === undefined || now >= entry.resetAt) {
      hits.set(address, { count: 1, resetAt: now + ROUTE_WINDOW_MS })
      return true
    }
    entry.count += 1
    return entry.count <= ROUTE_LIMIT
  }

  const keyMatches = (req: IncomingMessage): boolean => {
    const presented = req.headers['x-hub-key']
    if (typeof presented !== 'string') return false
    const buffer = Buffer.from(presented)
    return buffer.length === key.length && timingSafeEqual(buffer, key)
  }

  return {
    kind: 'prefix',
    path: options.basePath,
    handler: async (req, res) => {
      try {
        if (!allowed(req) || !withinRate(req)) {
          writeJson(res, 403, { error: 'forbidden' })
          return
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        if (req.method === 'GET' && url.pathname === `${options.basePath}/status`) {
          writeJson(res, 200, options.buildStatus())
          return
        }
        if (req.method === 'POST' && url.pathname === `${options.basePath}/action`) {
          if (!keyMatches(req)) {
            writeJson(res, 401, { error: 'unauthorized' })
            return
          }
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid_body' })
            return
          }
          const action = parseAction(body)
          if (action === undefined) {
            writeJson(res, 400, { error: 'invalid_action' })
            return
          }
          const result = await options.dispatch(action)
          writeJson(res, 200, { ...result, status: options.buildStatus() })
          return
        }
        writeJson(res, 404, { error: 'not_found' })
      } catch (error) {
        options.log.error(`route failed: ${error instanceof Error ? error.message : String(error)}`)
        if (!res.headersSent) writeJson(res, 500, { error: 'internal_error' })
        else res.destroy()
      }
    },
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) return undefined
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function parseAction(value: unknown): HubAction | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const type = record['type']
  if (typeof type !== 'string' || !ACTION_TYPES.has(type as HubAction['type'])) return undefined
  if (type === 'refresh-status') return { type }
  const provider = record['provider']
  if (provider === undefined || !PROVIDER_IDS.includes(provider as ProviderId)) return undefined
  const action = { ...record, type, provider } as HubAction
  if (action.type === 'save-secret') {
    if (typeof action.secret !== 'string' || action.secret.length === 0 || action.secret.length > 4096) return undefined
  }
  if (action.type === 'transfer-preview' || action.type === 'transfer-import') {
    if (typeof action.text !== 'string' || action.text.length === 0 || action.text.length > MAX_TEXT_LENGTH) return undefined
  }
  if (action.type === 'transfer-import' || action.type === 'transfer-export') {
    if (!Array.isArray(action.accountIds) || action.accountIds.length > 200
      || action.accountIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) return undefined
  }
  if (action.type === 'set-models-enabled') {
    if (!Array.isArray(action.modelIds) || action.modelIds.length > 500
      || action.modelIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) return undefined
    if (typeof action.enabled !== 'boolean') return undefined
  }
  if (action.type === 'set-model-enabled') {
    if (typeof action.modelId !== 'string' || action.modelId.length === 0 || action.modelId.length > 200) return undefined
    if (typeof action.enabled !== 'boolean') return undefined
  }
  if (action.type === 'set-checkin') {
    if (action.enabled !== undefined && typeof action.enabled !== 'boolean') return undefined
    if (action.minute !== undefined && (typeof action.minute !== 'number' || !Number.isInteger(action.minute)
      || action.minute < 0 || action.minute > 1439)) return undefined
  }
  if (action.type === 'set-max-context' && typeof action.useMax !== 'boolean') return undefined
  if (action.type === 'set-probe-consent' && typeof action.consent !== 'boolean') return undefined
  if (action.type === 'checkin' || action.type === 'select-account') {
    if (action.accountId !== undefined && (typeof action.accountId !== 'string' || action.accountId.length === 0 || action.accountId.length > 200)) return undefined
  }
  if (action.type === 'probe-model' && (typeof action.modelId !== 'string' || action.modelId.length === 0 || action.modelId.length > 200)) return undefined
  if (action.type === 'test-models') {
    if (!Array.isArray(action.modelIds) || action.modelIds.length > 500
      || action.modelIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) return undefined
  }
  return action
}
