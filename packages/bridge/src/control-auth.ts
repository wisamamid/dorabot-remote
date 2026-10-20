import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'

/**
 * Local control page authentication.
 *
 * Loopback + Host + Origin checks stop the network and the browser, but not
 * another process or user on this Mac. So the control API also needs a per-install
 * secret (32 random bytes, 0600). A browser gets in by exchanging a one-time login
 * token (minted by the CLI into the bridge DB) for an HttpOnly SameSite=Strict
 * cookie; the CLI itself may send the secret as a bearer token.
 */
export const COOKIE_NAME = 'dr_ctl'
export const COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60

export function controlSecretPath(root: string): string {
  return join(root, 'control-secret')
}

/** Read the install secret, creating it (mode 0600) on first use. Returns hex. */
export function loadControlSecret(root: string): string {
  const path = controlSecretPath(root)
  if (existsSync(path)) {
    const v = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(v)) {
      chmodSync(path, 0o600)
      return v
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const secret = randomBytes(32).toString('hex')
  writeFileSync(path, `${secret}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return secret
}

/** The cookie value: an HMAC of the secret, so the secret itself never reaches the browser. */
export function sessionCookieValue(secret: string): string {
  return createHmac('sha256', secret).update('dorabot-remote/control-session/v1').digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/** True if the request carries a valid session cookie or `Authorization: Bearer <secret>`. */
export function isControlAuthorized(req: IncomingMessage, secret: string): boolean {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), secret)) return true
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME]
  return typeof cookie === 'string' && safeEqual(cookie, sessionCookieValue(secret))
}

export function sessionSetCookie(secret: string): string {
  return `${COOKIE_NAME}=${sessionCookieValue(secret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`
}

/** URL the CLI opens: the one-time token is swapped for the cookie on first load. */
export function loginUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?login=${encodeURIComponent(token)}`
}
