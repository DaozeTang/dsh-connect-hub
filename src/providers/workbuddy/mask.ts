/**
 * Host-side masking for personal identifiers that reach the status document.
 * Display names are shown as-is unless they look like an email address or a
 * phone number; credentials are only ever described by a masked tail.
 */

import { maskTail } from '../../core/redact.ts'

const IDENTITY_SEPARATOR = ':'
const DETAIL_SEPARATOR = ' · '

export { maskAccountLabel } from '../../core/redact.ts'

/** Describe a token by its masked tail only; never returns the value itself. */
export function maskToken(token: string | undefined): string | undefined {
  return maskTail(token, 4)
}

/** A stable non-secret account identity: `uid:enterpriseId`. */
function identityOf(credential: { uid: string; enterpriseId?: string }): string {
  return `${credential.uid}${IDENTITY_SEPARATOR}${credential.enterpriseId ?? ''}`
}

/** The account identity persisted alongside catalogs and probe records. */
export function accountKeyOf(credential: { uid: string; enterpriseId?: string }): string {
  return identityOf(credential)
}

/**
 * The key model-visibility preferences are stored under, or `undefined` when
 * the credential carries no uid.
 *
 * A uid-less credential would otherwise key every such account to the same
 * `":enterpriseId"` bucket, so those accounts get no per-account preferences.
 */
export function visibilityAccountOf(credential: { uid: string; enterpriseId?: string }): string | undefined {
  if (credential.uid === '') return undefined
  return identityOf(credential)
}

/** Short non-secret detail line for the account: masked uid plus domain. */
export function accountDetailOf(credential: { uid: string; domain: string; enterpriseId?: string }): string | undefined {
  const parts = [
    credential.uid === '' ? undefined : `uid ${maskTail(credential.uid, 4) ?? '****'}`,
    credential.domain === '' ? undefined : credential.domain,
  ].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(DETAIL_SEPARATOR)
}
