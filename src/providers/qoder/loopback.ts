/**
 * Host and origin checks for the provider's loopback surfaces.
 *
 * The local OpenAI-compatible endpoint is only ever meant to be reached through
 * the machine's loopback interface. A DNS-rebinding page addresses
 * `127.0.0.1` while carrying its own domain in `Host`, so the host check below
 * rejects those requests before they reach any handler.
 */

/** Hostnames (with or without an explicit port) that name the loopback interface. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Return a leading bracketed IPv6 literal (with its optional port removed), if present. */
function bracketedHostPart(authority: string): string | undefined {
  if (!authority.startsWith('[')) return undefined
  const closingBracket = authority.indexOf(']')
  return closingBracket === -1 ? authority : authority.slice(0, closingBracket + 1)
}

/** Whether every character is an ASCII digit (an empty string is not). */
function isDecimalPort(text: string): boolean {
  if (text === '') return false
  for (const character of text) {
    const code = character.charCodeAt(0)
    if (code < 0x30 || code > 0x39) return false
  }
  return true
}

/** Remove a trailing `:port` from a non-bracketed authority, if one is present. */
function withoutPortSuffix(authority: string): string {
  const colon = authority.lastIndexOf(':')
  if (colon === -1) return authority
  const namePart = authority.slice(0, colon)
  // More than one colon before the suffix means an unbracketed IPv6 literal,
  // which has no port to strip.
  if (namePart.includes(':')) return authority
  return isDecimalPort(authority.slice(colon + 1)) ? namePart : authority
}

/** Strip the optional port from a Host header value, IPv6-bracket aware. */
export function hostnameOfHost(host: string): string {
  const authority = host.trim().toLowerCase()
  return bracketedHostPart(authority) ?? withoutPortSuffix(authority)
}

/** Whether a request's Host header names the machine's loopback interface. */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * Whether a browser-supplied Origin is a loopback origin. Native clients (the
 * plugin's own fetch calls) send no Origin at all and are accepted.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname.toLowerCase()) || hostname.toLowerCase() === '::1'
  } catch {
    return false
  }
}
