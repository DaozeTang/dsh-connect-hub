/**
 * Wire-level vocabulary shared by the Trae transport clients.
 *
 * Every network client in this provider answers with the same small result
 * union, so callers can branch on one `ok` flag and translate `kind` into an
 * HTTP status without knowing which wire family produced it.
 */

/** Stable failure families a Trae endpoint can report. */
export type TraeUpstreamErrorKind =
  | 'authentication'
  | 'hard_credit'
  | 'soft_rate'
  | 'not_found'
  | 'server'
  | 'client'
  | 'unconfigured'

interface TraeChatFailure {
  ok: false
  status: number
  kind: TraeUpstreamErrorKind
  message: string
}

interface TraeChatSuccess {
  ok: true
  response: Response
}

/** Outcome of one streaming chat request. */
export type TraeChatResult = TraeChatSuccess | TraeChatFailure

/** One upstream transport: takes the OpenAI-shaped request body and streams back. */
export interface TraeUpstreamClient {
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>
}
