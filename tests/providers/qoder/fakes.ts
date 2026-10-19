import type { HubLogger } from '../../../src/core/log.ts'

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

export interface FakeFetch {
  fetch: typeof fetch
  requests: CapturedRequest[]
}

/** A fake `fetch` that records requests and answers via `routes`; never network. */
export function captureFetch(
  routes: (url: string, request: CapturedRequest) => Response | undefined,
): FakeFetch {
  const requests: CapturedRequest[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : (input as { url: string }).url
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value
    }
    const request: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    requests.push(request)
    const response = routes(url, request)
    if (response === undefined) throw new Error(`unexpected fake fetch: ${request.method} ${url}`)
    return response
  }) as typeof fetch
  return { fetch: fetchImpl, requests }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Quiet logger for stores that report through the hub logger seam. */
export function testLogger(): HubLogger {
  const logger: HubLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  }
  return logger
}
