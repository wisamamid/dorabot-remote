/**
 * Compression for large host -> phone frames, applied inside the encrypted channel
 * (compress, then encrypt).
 *
 * Plaintext framing, decided by the first byte so decoding is deterministic:
 *
 *   '{' (0x7b)                      UTF-8 JSON, uncompressed (every envelope is an object)
 *   0x01 | u32be rawLen | deflate   raw DEFLATE (RFC 1951) of the UTF-8 JSON
 *
 * Policy (CRIME/BREACH hygiene): only frames whose JSON exceeds COMPRESS_MIN_BYTES are
 * compressed, and only host -> phone. Small frames (keystrokes, prompts, approvals) and
 * everything the phone sends are never compressed, so attacker-influenced input is not
 * mixed with secrets in one compressed block whose length an observer could measure.
 *
 * The declared length is checked against MAX_INFLATED_BYTES before anything is
 * allocated, and the inflated output must match it exactly (zip-bomb guard).
 */
import { inflateSync } from 'fflate'

/** Capability string a phone advertises in its encrypted `auth` envelope. */
export const CAP_DEFLATE = 'deflate'
/** JSON larger than this (bytes) may be compressed; anything at or below never is. */
export const COMPRESS_MIN_BYTES = 4096
/** Largest plaintext a compressed frame may expand to. */
export const MAX_INFLATED_BYTES = 8 * 1024 * 1024
export const FLAG_DEFLATE = 0x01
const HEADER_BYTES = 5

/** Wrap deflate-raw bytes (of a JSON body `rawLength` bytes long) as a sealed plaintext. */
export function frameDeflated(rawLength: number, deflated: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + deflated.length)
  out[0] = FLAG_DEFLATE
  new DataView(out.buffer).setUint32(1, rawLength, false)
  out.set(deflated, HEADER_BYTES)
  return out
}

export function isCompressedFrame(plain: Uint8Array): boolean {
  return plain.length > 0 && plain[0] === FLAG_DEFLATE
}

/** Inflate a compressed plaintext frame back to the JSON bytes. Throws on any irregularity. */
export function inflateFrame(plain: Uint8Array): Uint8Array {
  if (plain.length <= HEADER_BYTES) throw new Error('compressed frame is truncated')
  const rawLength = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(1, false)
  if (rawLength === 0 || rawLength > MAX_INFLATED_BYTES) throw new Error('compressed frame declares an invalid size')
  // One spare byte: fflate silently clamps output to the buffer, so an overrun
  // shows up as a result of rawLength + 1 rather than being swallowed.
  let out: Uint8Array
  try {
    out = inflateSync(plain.subarray(HEADER_BYTES), { out: new Uint8Array(rawLength + 1) })
  } catch {
    throw new Error('compressed frame is corrupt')
  }
  if (out.length !== rawLength) throw new Error('compressed frame size mismatch')
  return out
}
