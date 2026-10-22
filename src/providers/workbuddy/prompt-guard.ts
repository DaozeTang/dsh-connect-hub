export const GUARDED_PHRASES: readonly string[] = [
  'You are an AI agent powered by DeepSeek Harness',
  'You are an AI agent powered by DeepSeek',
  'an AI agent powered by DeepSeek Harness',
  'powered by DeepSeek Harness',
  'DeepSeek Harness',
]

export const GUARD_JOINER = '\u200B'

const PATH_SEPARATORS: ReadonlySet<string> = new Set(['/', '\\', ':'])

const PATH_LIKE = /\S*[/\\]\S*/gu

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function phrasePattern(phrase: string): RegExp {
  const body = phrase.trim().split(/\s+/u).map(escapeRegExp).join('\\s+')
  return new RegExp(`(?<![/\\\\\\w.-])${body}(?![\\w/\\\\-])`, 'giu')
}

function pathRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = []
  for (const match of text.matchAll(PATH_LIKE)) {
    const start = match.index
    if (start === undefined) continue
    ranges.push([start, start + match[0].length])
  }
  return ranges
}

function overlaps(ranges: Array<readonly [number, number]>, start: number, end: number): boolean {
  return ranges.some(([from, to]) => start < to && end > from)
}

function touchesPathCharacter(text: string, start: number, end: number): boolean {
  const before = start === 0 ? '' : text[start - 1] ?? ''
  const after = end >= text.length ? '' : text[end] ?? ''
  return PATH_SEPARATORS.has(before) || PATH_SEPARATORS.has(after)
}

function alreadyNeutralized(text: string, start: number, end: number): boolean {
  if (text[start - 1] === GUARD_JOINER) return true
  if (text[end] === GUARD_JOINER) return true
  return text.slice(start, end).includes(GUARD_JOINER)
}

interface Insertion {
  start: number
  end: number
  at: number
}

export interface GuardResult {
  text: string
  replacements: number
}

export function neutralizeText(text: string): GuardResult {
  if (text === '') return { text, replacements: 0 }
  const ranges = pathRanges(text)

  const candidates: Insertion[] = []
  for (const phrase of GUARDED_PHRASES) {
    for (const match of text.matchAll(phrasePattern(phrase))) {
      const start = match.index
      if (start === undefined) continue
      const end = start + match[0].length
      if (touchesPathCharacter(text, start, end)) continue
      if (overlaps(ranges, start, end)) continue
      if (alreadyNeutralized(text, start, end)) continue
      const space = match[0].lastIndexOf(' ')
      if (space <= 0) continue
      candidates.push({ start, end, at: start + space })
    }
  }
  if (candidates.length === 0) return { text, replacements: 0 }

  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const accepted: Insertion[] = []
  for (const candidate of candidates) {
    if (accepted.some((taken) => candidate.start < taken.end && candidate.end > taken.start)) continue
    accepted.push(candidate)
  }

  let output = text
  for (const insertion of [...accepted].sort((a, b) => b.at - a.at)) {
    output = `${output.slice(0, insertion.at)}${GUARD_JOINER}${output.slice(insertion.at)}`
  }
  return { text: output, replacements: accepted.length }
}

function guardedRole(role: unknown): boolean {
  return role === 'system' || role === 'developer'
}

export function neutralizeBody(body: Record<string, unknown>): number {
  const messages = body['messages']
  if (!Array.isArray(messages)) return 0
  let replacements = 0
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const wrapped = message as Record<string, unknown>
    if (!guardedRole(wrapped['role'])) continue
    const content = wrapped['content']
    if (typeof content !== 'string' || content === '') continue
    const guarded = neutralizeText(content)
    if (guarded.replacements === 0) continue
    wrapped['content'] = guarded.text
    replacements += guarded.replacements
  }
  return replacements
}

export interface PromptGuardOptions {
  enabled?: boolean
  onApplied?: (replacements: number) => void
}

export function applyPromptGuard(body: Record<string, unknown>, options?: PromptGuardOptions): number {
  if (options?.enabled === false) return 0
  const replacements = neutralizeBody(body)
  if (replacements > 0) options?.onApplied?.(replacements)
  return replacements
}
