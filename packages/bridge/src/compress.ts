import { deflateRawSync } from 'node:zlib'
import { COMPRESS_MIN_BYTES, MAX_INFLATED_BYTES, frameDeflated } from '@dorabot-remote/protocol'

/**
 * Encode an outbound envelope as sealed plaintext. Compresses (deflate-raw, level 6) only
 * when the peer advertised support AND the JSON exceeds COMPRESS_MIN_BYTES, and only when
 * that actually makes it smaller. Everything else goes out as plain JSON bytes.
 */
export function encodeOutbound(env: unknown, peerDeflate: boolean): Uint8Array {
  const json = Buffer.from(JSON.stringify(env), 'utf8')
  if (!peerDeflate || json.length <= COMPRESS_MIN_BYTES || json.length > MAX_INFLATED_BYTES) return json
  const framed = frameDeflated(json.length, deflateRawSync(json, { level: 6 }))
  return framed.length < json.length ? framed : json
}
