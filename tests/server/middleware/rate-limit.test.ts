import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../../src/server/middleware/rate-limit.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 3 });
    expect(limiter.check('client-1').allowed).toBe(true);
    expect(limiter.check('client-1').allowed).toBe(true);
    expect(limiter.check('client-1').allowed).toBe(true);
  });

  it('blocks requests over the limit', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
    limiter.check('client-1');
    limiter.check('client-1');
    const result = limiter.check('client-1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets after the window expires', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
    limiter.check('client-1');
    expect(limiter.check('client-1').allowed).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.check('client-1').allowed).toBe(true);
  });

  it('tracks clients independently', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
    limiter.check('client-1');
    expect(limiter.check('client-2').allowed).toBe(true);
  });
});
