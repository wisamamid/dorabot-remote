/**
 * Relay token rotation. Each device's relay token is HMAC(relaySecret, deviceId) for generation 0 and
 * HMAC(relaySecret, "<deviceId>#<gen>") after that, so a rotation is a generation bump and nothing but the
 * small state below needs storing.
 *
 * Rules:
 *  - Every 30 days (and on demand) a device moves to the next generation. Only devices that have acked their
 *    current token rotate on schedule: an app build that cannot ack would otherwise be cut off.
 *  - The phone receives the new token over the end-to-end channel (the `ready` envelope, or a live
 *    `remote.relay_token` event) and acks it (remote.relayTokAck) once it has stored it.
 *  - Until that ack, the previous token(s) stay valid, for at most 7 days. The ack drops them at once.
 */
export const ROTATE_EVERY_MS = 30 * 24 * 60 * 60 * 1000
export const PREV_VALID_MS = 7 * 24 * 60 * 60 * 1000

export interface TokState {
  gen: number
  /** When the current generation was issued. */
  issuedAt: number
  /** The phone confirmed it stored the current token. */
  acked: boolean
  /** Older generations that still work, with the time each stops. */
  prev: Array<{ gen: number; until: number }>
}

export function initialState(createdAt: number, acked: boolean): TokState {
  return { gen: 0, issuedAt: createdAt, acked, prev: [] }
}

/** The id string the token is derived from. Generation 0 is the original derivation, so existing tokens keep working. */
export function tokenSubject(deviceId: string, gen: number): string {
  return gen === 0 ? deviceId : `${deviceId}#${gen}`
}

export function rotate(s: TokState, now: number): TokState {
  // An unacked current token may be sitting on a phone that has not told us yet, so it stays valid too.
  const prev = [...pruneExpired(s, now).prev, { gen: s.gen, until: now + PREV_VALID_MS }]
  return { gen: s.gen + 1, issuedAt: now, acked: false, prev }
}

/** The phone confirmed the current token: nothing older needs to work any more. */
export function ackCurrent(s: TokState): TokState {
  return { ...s, acked: true, prev: [] }
}

export function pruneExpired(s: TokState, now: number): TokState {
  const prev = s.prev.filter((p) => p.until > now)
  return prev.length === s.prev.length ? s : { ...s, prev }
}

export function dueForRotation(s: TokState, now: number): boolean {
  return s.acked && now - s.issuedAt >= ROTATE_EVERY_MS
}

/** Every generation whose token the relay should currently accept: the current one and unexpired older ones. */
export function validGens(s: TokState, now: number): number[] {
  return [s.gen, ...pruneExpired(s, now).prev.map((p) => p.gen)]
}
