/**
 * Minimal fixed-window rate limiter (no extra dependency).
 *
 * Counts live in this server's memory, which is fine for a single instance.
 * If you ever run several instances, swap this for a shared store like Redis.
 */
const MAX_TRACKED_KEYS = 50_000; // keeps memory bounded if someone floods with fake emails

export function createRateLimiter({
  windowMs,
  max,
  key = (req) => req.ip,
  message = 'Too many attempts.',
}) {
  const hits = new Map(); // key -> { count, resetAt }

  // Forget expired entries so the map doesn't grow forever
  setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(k);
    }
  }, Math.min(windowMs, 60_000)).unref();

  const middleware = (req, res, next) => {
    const now = Date.now();
    const k = key(req);

    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      if (hits.size >= MAX_TRACKED_KEYS) hits.clear();
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      const seconds = Math.ceil((entry.resetAt - now) / 1000);
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      res.set('Retry-After', String(seconds));
      return res.status(429).json({
        error: `${message} Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      });
    }

    next();
  };

  /** Clears this request's counter, e.g. after a successful login. */
  middleware.reset = (req) => {
    hits.delete(key(req));
  };

  return middleware;
}
