/** Refills continuously; `take` is true while there is budget for one more frame. */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    now = Date.now(),
  ) {
    this.tokens = capacity
    this.last = now
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.capacity) / this.windowMs)
    this.last = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

/** Fixed budget per sliding window, for push sends. */
export class SlidingWindow {
  private hits: number[] = []

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs)
    if (this.hits.length >= this.max) return false
    this.hits.push(now)
    return true
  }
}

export const LIMITS = {
  maxDevices: 32,
  maxFrameBytes: 1024 * 1024,
  /** ~300 frames per 10s per device. */
  deviceFrames: 300,
  deviceWindowMs: 10_000,
  hostAuthTimeoutMs: 10_000,
  maxPendingHosts: 4,
  /** Sockets that have connected but not yet presented a token. */
  maxPendingDevices: 32,
  deviceAuthTimeoutMs: 5000,
  /** Per client IP (CF-Connecting-IP), per room. */
  ipConnsPerWindow: 20,
  ipWindowMs: 60_000,
  ipMaxDevices: 8,
  /** Cap on stored token hashes / live pairing tickets. */
  maxTokens: 200,
  maxTickets: 16,
  ticketTtlMs: 10 * 60_000,
  pushDedupeMs: 10 * 60_000,
  pushDedupeMax: 4000,
  pushPerMinute: 60,
  pushWindowMs: 60_000,
  pushMaxAgeMs: 60_000,
  pushMaxBodyBytes: 8 * 1024,
} as const
