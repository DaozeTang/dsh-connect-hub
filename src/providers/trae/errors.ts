/**
 * Redaction helpers for anything that can reach the browser.
 *
 * `status()` warnings and action messages are user-facing strings assembled
 * from provider errors, so they are scrubbed for bearer material, OS account
 * names and absurd length before they leave the host. The logger has its own
 * redaction layer; these helpers cover the wire response.
 */

const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // JWT-shaped strings (three base64url segments starting with a JSON header).
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[redacted token]' },
  // Authorization header values.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1 [redacted]' },
  // `token=...`, `Authorization: ...` and friends.
  { pattern: /\b(token|pat|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi, replacement: '$1$2[redacted]' },
  // The OS account name embedded in a home directory.
  { pattern: /(\/(?:Users|home)\/)[^/\s]+/g, replacement: '$1<user>' },
  { pattern: /([A-Za-z]:\\Users\\)[^\\\s]+/gi, replacement: '$1<user>' },
]

/** Short hidden form of an email local part. */
function hideEmailLabel(text: string): string | undefined {
  const at = text.indexOf('@')
  if (at <= 0) return undefined
  const local = text.slice(0, at)
  const domain = text.slice(at + 1)
  return local.length <= 2
    ? `***@${domain}`
    : `${local.slice(0, 1)}***${local.slice(-1)}@${domain}`
}

/** Short hidden form of a phone-like identifier, or undefined when not phone-like. */
function hidePhoneLabel(text: string): string | undefined {
  const digits = text.replace(/[\s-]/g, '')
  if (!/^\+?\d{5,}$/.test(digits)) return undefined
  const visible = digits.length <= 7 ? 2 : 4
  return `***${digits.slice(-visible)}`
}

/** A user-facing error string: no credential material, no OS account name, bounded. */
export function safeErrorText(error: unknown, limit = 300): string {
  let text = error instanceof Error ? error.message : String(error)
  for (const { pattern, replacement } of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  return text.trim().slice(0, limit)
}

/**
 * Account labels may be shown, but an identifier that is an email address or a
 * phone number must be masked host-side. Ordinary nicknames pass through.
 */
export function maskAccountName(label: string): string {
  const text = label.trim()
  if (text === '') return label
  return hideEmailLabel(text) ?? hidePhoneLabel(text) ?? text
}
