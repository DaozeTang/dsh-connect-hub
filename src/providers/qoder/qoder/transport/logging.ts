/**
 * Diagnostic logging helpers for the Qoder transport.
 *
 * Provider values that reach a log line are bounded and scrubbed here first:
 * credentials are removed, account identifiers are masked, and deeply nested
 * structures are cut off.
 */

/** Minimal logger surface the transport accepts; every level is optional. */
export interface QoderLogger {
  debug?(message: string, ...details: unknown[]): void
  warn?(message: string, ...details: unknown[]): void
  error?(message: string, ...details: unknown[]): void
}

const SENSITIVE_KEY = /(?:authorization|credential|password|secret|token)/iu
const IDENTIFIER_KEY = /^(?:accountId|id|uid|userId)$/iu
const SCOPED_TOKEN = /\b(?:jrt|jt|pt)-[\w.-]+\b/giu
const BEARER_HEADER = /Bearer\s+[^\s,;]+/giu

const MAX_DEPTH = 4
const MAX_ITEMS = 50
const MAX_TEXT_LENGTH = 500
const TRUNCATED_TEXT_SUFFIX = '…'
const REDACTED = '[REDACTED]'
const TRUNCATED_VALUE = '[TRUNCATED]'

/** Bound one string and remove token-looking content from it. */
function scrubText(value: string): string {
  const bounded = value.length > MAX_TEXT_LENGTH
    ? `${value.slice(0, MAX_TEXT_LENGTH)}${TRUNCATED_TEXT_SUFFIX}`
    : value
  return bounded.replace(SCOPED_TOKEN, REDACTED).replace(BEARER_HEADER, `Bearer ${REDACTED}`)
}

/** Mask an account identifier down to its last four characters. */
function maskIdentifier(value: unknown): string {
  const text = String(value)
  return text.length <= 4 ? REDACTED : `${TRUNCATED_TEXT_SUFFIX}${text.slice(-4)}`
}

/** Mask the local part of an email address, keeping the domain readable. */
function maskEmail(value: unknown): string {
  const text = String(value)
  const at = text.indexOf('@')
  return at <= 0 ? REDACTED : `${text.slice(0, 1)}***${text.slice(at)}`
}

/** Scrub one value recursively, bounded in depth and width. */
function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return TRUNCATED_VALUE
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubText(value.message),
      ...('code' in value ? { code: scrubValue(value.code, depth + 1) } : {}),
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map(item => scrubValue(item, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_ITEMS)
      .map(([key, item]) => {
        if (SENSITIVE_KEY.test(key)) return [key, REDACTED]
        if (IDENTIFIER_KEY.test(key)) return [key, maskIdentifier(item)]
        if (key.toLowerCase() === 'email') return [key, maskEmail(item)]
        return [key, scrubValue(item, depth + 1)]
      }),
  )
}

/** Redact credentials and bound arbitrary provider values before logging them. */
export function redactLogValue(value: unknown, depth = 0): unknown {
  return scrubValue(value, depth)
}

/** Parse JSON-shaped diagnostics when possible, then apply the same scrubbing. */
export function redactLogPayload(text: string): unknown {
  try {
    return redactLogValue(JSON.parse(text))
  } catch {
    return redactLogValue(text)
  }
}

/** Log one successfully parsed non-stream response through the shared scrubbing policy. */
export function logParsedResponse(
  logger: QoderLogger | undefined,
  operation: string,
  result: unknown,
): void {
  logger?.debug?.('[Qoder Response] Parsed', redactLogValue({ operation, result }))
}
