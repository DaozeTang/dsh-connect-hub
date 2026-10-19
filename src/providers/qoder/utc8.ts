/**
 * Beijing-time arithmetic shared by the check-in scheduler and the campaign
 * reader.
 *
 * The daily benefit window is tied to the UTC+8 wall clock, not to the host's
 * calendar: a claim moment must be evaluated identically no matter which
 * timezone the machine is configured for. Every conversion therefore funnels
 * through the two helpers below.
 */

/** Beijing time's offset from UTC, in minutes. */
export const UTC8_OFFSET_MINUTES = 8 * 60

/** How far the host's local clock sits from UTC, in milliseconds. */
function hostLocalCorrectionMs(instant: Date): number {
  return instant.getTimezoneOffset() * 60_000
}

/**
 * Re-express an instant as a Date whose *local* fields read the UTC+8 wall
 * clock. Callers must use the local getters (`getHours`, `getFullYear`, …).
 *
 * Adding the host's own correction cancels the machine timezone out, then the
 * fixed region offset shifts the clock to Beijing time.
 */
export function utc8WallClock(atMs: number): Date {
  const instant = new Date(atMs)
  return new Date(instant.getTime() + hostLocalCorrectionMs(instant) + UTC8_OFFSET_MINUTES * 60_000)
}

/** Zero-pad one calendar component to two digits. */
function twoDigits(value: number): string {
  return value.toString().padStart(2, '0')
}

/** The UTC+8 calendar date of an instant, formatted `YYYY-MM-DD`. */
export function formatUtc8Date(atMs: number): string {
  const wallClock = utc8WallClock(atMs)
  return [
    wallClock.getFullYear().toString(),
    twoDigits(wallClock.getMonth() + 1),
    twoDigits(wallClock.getDate()),
  ].join('-')
}
