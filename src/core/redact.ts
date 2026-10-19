const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const SECRET_PAIR = /\b(token|pat|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi
const LONG_HEX = /\b[a-f0-9]{48,}\b/gi

export function redactText(input: string, secrets: readonly string[] = []): string {
  let text = input
  for (const secret of secrets) {
    if (secret.length >= 6) text = text.split(secret).join('[redacted]')
  }
  return text
    .replace(PEM_BLOCK, '[redacted key]')
    .replace(JWT, '[redacted token]')
    .replace(BEARER, '$1 [redacted]')
    .replace(SECRET_PAIR, '$1$2[redacted]')
    .replace(LONG_HEX, '[redacted]')
}

export function redactHome(input: string, home: string): string {
  return home.length > 1 ? input.split(home).join('~') : input
}

/** Internal error prefixes that aid logs but must never reach a user surface. */
const INTERNAL_ERROR_MARKER = /\bMISSING_CREDENTIAL:\s*/gu

/** Remove internal error markers from text that is shown in the UI. */
export function stripInternalErrorMarkers(input: string): string {
  return input.replace(INTERNAL_ERROR_MARKER, '')
}

export function maskTail(secret: string | undefined, visible = 4): string | undefined {
  if (secret === undefined || secret.length === 0) return undefined
  if (secret.length <= visible) return '****'
  return `****${secret.slice(-visible)}`
}

/** Shapes a display name takes when it is really an account identifier. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const PHONE_SHAPE = /^\+?\d[\d\s-]{5,}$/u

/**
 * Mask an account display name that is actually an email address or phone
 * number; everything else is returned as written.
 */
export function maskAccountLabel(value: string | undefined): string | undefined {
  const label = value?.trim()
  if (label === undefined || label === '') return undefined
  if (EMAIL_SHAPE.test(label)) {
    const at = label.indexOf('@')
    return `${label.slice(0, 1)}***@${label.slice(at + 1)}`
  }
  if (PHONE_SHAPE.test(label)) {
    const digits = label.replace(/\D/gu, '')
    return maskTail(digits, 4) ?? '****'
  }
  return label
}
