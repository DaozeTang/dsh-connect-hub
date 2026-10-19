/**
 * Loopback gates for the provider's local HTTP surface. A Host header that does
 * not name the loopback interface, or a cross-origin browser request, is
 * rejected before any routing happens.
 */

/** Hostnames a loopback-addressed local surface may name. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Separator between a URL host and its port. */
interface HostParts {
  hostname: string
  port: string | undefined
}

/** Split a raw Host header into hostname and an optional numeric port. */
function parseHostHeader(value: string): HostParts {
  const text = value.trim().toLowerCase()
  if (text.startsWith('[')) {
    // Bracketed IPv6 literal: the address is complete at the closing bracket.
    const closing = text.indexOf(']')
    if (closing === -1) return { hostname: text, port: undefined }
    const tail = text.slice(closing + 1)
    return {
      hostname: text.slice(0, closing + 1),
      port: tail.startsWith(':') ? tail.slice(1) : undefined,
    }
  }
  const boundary = text.lastIndexOf(':')
  if (boundary === -1 || text.slice(0, boundary).includes(':')) {
    // No separator, or an unbracketed IPv6 literal: nothing to strip.
    return { hostname: text, port: undefined }
  }
  const candidatePort = text.slice(boundary + 1)
  if (!/^\d+$/u.test(candidatePort)) return { hostname: text, port: undefined }
  return { hostname: text.slice(0, boundary), port: candidatePort }
}

/** The hostname of a Host header value, without its port. */
export function hostnameOfHost(host: string): string {
  return parseHostHeader(host).hostname
}

/** Whether a Host header value names the loopback interface. */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * Whether a browser-sent Origin is loopback. A non-browser client (the
 * provider's own fetch calls) sends no Origin and is allowed through.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  let hostname: string
  try {
    hostname = new URL(origin).hostname
  } catch {
    return false
  }
  return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
}
