import type { Context } from '@deepseek-ai/cordis'
import { redactHome, redactText } from './redact.ts'

export interface HubLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  child(tag: string): HubLogger
}

interface BaseLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export function createHubLogger(ctx: Context, home: string): HubLogger {
  const base = (ctx as unknown as { logger?: BaseLogger }).logger
  const sink: BaseLogger = base ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  return wrapper('connect-hub', sink, home)
}

function wrapper(tag: string, sink: BaseLogger, home: string): HubLogger {
  const clean = (message: string): string => redactHome(redactText(message), home)
  return {
    info: (message) => { sink.info(`[${tag}] ${clean(message)}`) },
    warn: (message) => { sink.warn(`[${tag}] ${clean(message)}`) },
    error: (message) => { sink.error(`[${tag}] ${clean(message)}`) },
    child: (name) => wrapper(`${tag}:${name}`, sink, home),
  }
}
