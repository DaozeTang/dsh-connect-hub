/**
 * Closed vocabulary of reasons a WorkBuddy sign-in cannot be used.
 *
 * The hub branches on these codes; the paired human-readable message is
 * presentation only and never matched against.
 */
export const WORKBUDDY_SIGNED_OUT_CAUSES = [
  'no-credential',
  'credential-region-mismatch',
  'encrypted-credential-unreadable',
  'electron-binary-not-found',
  'electron-binary-ambiguous',
  'electron-binary-unavailable',
  'electron-path-invalid',
  'electron-discovery-incomplete',
] as const

/** One machine-readable reason a credential is unusable. */
export type WorkBuddySignedOutReasonCode = (typeof WORKBUDDY_SIGNED_OUT_CAUSES)[number]
