import type { HubLogger } from '../../core/log.ts'
import type { QoderLogger } from './qoder/transport/logging.ts'
import type { ShimLogger } from './shim.ts'

/** Render one arbitrary diagnostic value for a single log line. */
function renderDetail(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    const encoded = JSON.stringify(value)
    return encoded ?? String(value)
  } catch {
    return String(value)
  }
}

/** The non-empty rendered details, in their original order. */
function renderedDetails(values: readonly unknown[]): string[] {
  const rendered: string[] = []
  for (const value of values) {
    const text = renderDetail(value)
    if (text !== '') rendered.push(text)
  }
  return rendered
}

/** Append details to a message, keeping the single-space separator. */
function messageWithDetails(message: string, details: readonly unknown[]): string {
  const extra = renderedDetails(details)
  return extra.length === 0 ? message : `${message} ${extra.join(' ')}`
}

/** The shim reports bare values, so its line is just the joined arguments. */
function messageFromArguments(args: readonly unknown[]): string {
  return renderedDetails(args).join(' ')
}

interface Sink {
  warn(message: string): void
  error(message: string): void
}

function sinkFor(log: HubLogger): Sink {
  return {
    warn: message => { log.warn(message) },
    error: message => { log.error(message) },
  }
}

/**
 * Adapt the hub logger to the transport's optional diagnostic surface. The
 * transport already bounds and redacts what it logs; the hub logger applies its
 * own token/home scrubbing on top.
 */
export function qoderLoggerFor(log: HubLogger): QoderLogger {
  const sink = sinkFor(log)
  return {
    warn: (message, ...details) => { sink.warn(messageWithDetails(message, details)) },
    error: (message, ...details) => { sink.error(messageWithDetails(message, details)) },
  }
}

/** The loopback shim's logger; it only ever reports request or stream failures. */
export function shimLoggerFor(log: HubLogger): ShimLogger {
  const sink = sinkFor(log)
  return {
    warn: (...args) => { sink.warn(messageFromArguments(args)) },
    error: (...args) => { sink.error(messageFromArguments(args)) },
  }
}
