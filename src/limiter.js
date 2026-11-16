const { check, ALGORITHMS } = require("./algorithms");
const { redis } = require("./redis");

// Fallback used only while Redis is unreachable (per-process fixed window).
const memory = new Map();
function memoryCheck(key, limit, windowMs) {
  const now = Date.now();
  let e = memory.get(key);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + windowMs };
    memory.set(key, e);
  }
  e.count++;
  const allowed = e.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - e.count),
    retryAfterMs: allowed ? 0 : e.resetAt - now,
    resetMs: e.resetAt - now,
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
}, 30000).unref();

const defaultKey = (req) => req.headers["x-api-key"] || req.ip;

/**
 * options:
 *  algorithm    - token-bucket | sliding-window-log | sliding-window-counter
 *  limit        - number OR (req) => number   (enables per-tier limits)
 *  windowMs     - window length in ms
 *  keyPrefix    - namespace so routes have separate counters
 *  keyGenerator - (req) => string identifying the client
 *  failOpen     - true: use in-memory fallback if Redis fails; false: reply 503
 */
function rateLimiter(options = {}) {
  const {
    algorithm = "sliding-window-counter",
    limit = 60,
    windowMs = 60000,
    keyPrefix = "rl",
    keyGenerator = defaultKey,
    failOpen = true,
  } = options;

  if (!ALGORITHMS.includes(algorithm)) {
    throw new Error("algorithm must be one of: " + ALGORITHMS.join(", "));
  }

  return async function (req, res, next) {
    const max = typeof limit === "function" ? limit(req) : limit;
    const key = keyPrefix + ":" + keyGenerator(req);
    let result;

    try {
      result = await check(algorithm, key, { limit: max, windowMs });
    } catch (err) {
      if (!failOpen) {
        return res.status(503).json({ error: "Rate limiter unavailable" });
      }
      res.set("X-RateLimit-Mode", "fallback");
      result = memoryCheck(key, max, windowMs);
    }

    res.set("RateLimit-Limit", String(max));
    res.set("RateLimit-Remaining", String(result.remaining));
    res.set("RateLimit-Reset", String(Math.ceil(result.resetMs / 1000)));

    // Fire-and-forget metrics; never block the request on them.
    redis
      .hincrby("rl:stats", keyPrefix + ":" + (result.allowed ? "allowed" : "blocked"), 1)
      .catch(() => {});

    if (result.allowed) return next();

    const retry = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.set("Retry-After", String(retry));
    return res.status(429).json({
      error: "Too Many Requests",
      algorithm,
      retryAfterSeconds: retry,
    });
  };
}

module.exports = { rateLimiter };
