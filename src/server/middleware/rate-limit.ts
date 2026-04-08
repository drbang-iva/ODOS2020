interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();

  constructor(
    private opts: { windowMs: number; maxRequests: number },
  ) {}

  check(clientId: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const entry = this.entries.get(clientId);

    if (!entry || now - entry.windowStart > this.opts.windowMs) {
      this.entries.set(clientId, { count: 1, windowStart: now });
      return { allowed: true, retryAfterMs: 0 };
    }

    entry.count++;
    if (entry.count > this.opts.maxRequests) {
      const retryAfterMs = this.opts.windowMs - (now - entry.windowStart);
      return { allowed: false, retryAfterMs };
    }

    return { allowed: true, retryAfterMs: 0 };
  }
}
