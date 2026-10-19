import { HUB_ROUTE_BASE, type ActionResult, type HubAction, type HubStatus } from '../shared/contracts.ts'

const BASE = HUB_ROUTE_BASE
/** Status reads and short actions must answer promptly. */
const STATUS_TIMEOUT_MS = 20_000
/** Catalog/usage refreshes can legitimately outlive the 20 s status/short-action default. */
const LONG_ACTION_TIMEOUT_MS = 120_000

/** Action types whose upstream work is slow enough to need the longer cap. */
const LONG_ACTIONS: ReadonlySet<HubAction['type']> = new Set([
  'refresh-status',
  'refresh-catalog',
  'refresh-usage',
  'refresh-account',
  'test-models',
])

/** Timeout a client action may take; refreshes get the long budget. */
export function actionTimeoutMs(action: HubAction): number {
  return LONG_ACTIONS.has(action.type) ? LONG_ACTION_TIMEOUT_MS : STATUS_TIMEOUT_MS
}

let key: string | undefined

export class HubHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** One hub request with a timeout that is always cleared when the fetch settles. */
async function request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  timer.unref?.()
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...init.headers },
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchStatus(): Promise<HubStatus> {
  const response = await request('/status', { method: 'GET' }, STATUS_TIMEOUT_MS)
  if (!response.ok) throw new HubHttpError(response.status, `status ${response.status}`)
  const status = (await response.json()) as HubStatus
  key = status.key
  return status
}

export async function runAction(action: HubAction): Promise<ActionResult> {
  if (key === undefined) await fetchStatus()
  const attempt = async (): Promise<ActionResult> => {
    const response = await request('/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-key': key ?? '' },
      body: JSON.stringify(action),
    }, actionTimeoutMs(action))
    if (response.status === 401) {
      await fetchStatus()
      return attempt()
    }
    const body = (await response.json().catch(() => undefined)) as ActionResult | { error?: string } | undefined
    if (!response.ok) {
      const detail = body !== undefined && 'error' in body && typeof body.error === 'string' ? body.error : `status ${response.status}`
      throw new HubHttpError(response.status, detail)
    }
    return body as ActionResult
  }
  return attempt()
}
