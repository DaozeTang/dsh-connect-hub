/**
 * Cancellable response-header timeout composed with a caller-owned signal.
 *
 * `AbortSignal.timeout()` cannot be cleared, and a fetch signal stays attached
 * to the response BODY. Using it for a streaming chat request would therefore
 * cut a healthy long answer at the timeout. This helper times out only the wait
 * for response headers: once `fetch` resolves, {@link HeaderTimeout.settle}
 * clears the timer while the caller's signal stays wired to the request, so a
 * downstream "stop" still aborts the upstream generation.
 */
export interface HeaderTimeout {
  /** Signal to pass to `fetch`; aborts on caller abort or header timeout. */
  readonly signal: AbortSignal
  /** Clear the header timer after headers arrived; safe to call more than once. */
  settle(): void
}

export function responseHeaderTimeout(signal: AbortSignal | undefined, timeoutMs: number): HeaderTimeout {
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort(signal?.reason) }
  if (signal?.aborted === true) {
    controller.abort(signal.reason)
  } else if (signal !== undefined) {
    signal.addEventListener('abort', onAbort, { once: true })
  }
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined
    controller.abort(new Error(`upstream response header timeout after ${String(timeoutMs)}ms`))
  }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    settle(): void {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    },
  }
}
