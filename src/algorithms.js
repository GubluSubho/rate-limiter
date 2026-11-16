const crypto = require("crypto");
const { redis } = require("./redis");

// Every script returns { allowed (1/0), remaining, retryAfterMs, resetMs }.
// All time comes from Redis TIME, so app-server clocks never matter.
// Each script runs atomically: no race conditions under concurrency.

// 1) TOKEN BUCKET: allows bursts, refills steadily.
// ARGV: capacity, refill rate (tokens per ms)
const TOKEN_BUCKET = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end

tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)

local allowed, retry = 0, 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate) + 1000)
local reset = math.ceil((capacity - tokens) / rate)
return {allowed, math.floor(tokens), retry, reset}
`;

// 2) SLIDING WINDOW LOG: exact, stores every request timestamp.
// ARGV: window ms, limit, unique member
const SLIDING_LOG = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])

local allowed = 0
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  count = count + 1
  allowed = 1
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local reset = 0
if oldest[2] then reset = tonumber(oldest[2]) + window - now end
local retry = 0
if allowed == 0 then retry = reset end
return {allowed, limit - count, retry, reset}
`;

// 3) SLIDING WINDOW COUNTER: tiny memory (2 counters), approximate.
// Estimate = previous window * (fraction still overlapping) + current window.
// ARGV: window ms, limit
const SLIDING_COUNTER = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

local idx = math.floor(now / window)
local cur = KEYS[1] .. ':' .. idx
local prev = KEYS[1] .. ':' .. (idx - 1)

local c = tonumber(redis.call('GET', cur) or '0')
local p = tonumber(redis.call('GET', prev) or '0')
local elapsed = (now % window) / window
local estimate = p * (1 - elapsed) + c

local allowed = 0
if estimate < limit then
  redis.call('INCR', cur)
  redis.call('PEXPIRE', cur, window * 2)
  estimate = estimate + 1
  allowed = 1
end

local reset = window - (now % window)
local retry = 0
if allowed == 0 then retry = reset end
return {allowed, math.max(0, math.floor(limit - estimate)), retry, reset}
`;

redis.defineCommand("tokenBucket", { numberOfKeys: 1, lua: TOKEN_BUCKET });
redis.defineCommand("slidingLog", { numberOfKeys: 1, lua: SLIDING_LOG });
redis.defineCommand("slidingCounter", { numberOfKeys: 1, lua: SLIDING_COUNTER });

const ALGORITHMS = ["token-bucket", "sliding-window-log", "sliding-window-counter"];

async function check(algorithm, key, { limit, windowMs }) {
  let r;
  switch (algorithm) {
    case "token-bucket":
      r = await redis.tokenBucket(key, limit, limit / windowMs);
      break;
    case "sliding-window-log":
      r = await redis.slidingLog(key, windowMs, limit, crypto.randomUUID());
      break;
    case "sliding-window-counter":
      r = await redis.slidingCounter(key, windowMs, limit);
      break;
    default:
      throw new Error("Unknown algorithm: " + algorithm);
  }
  return {
    allowed: r[0] === 1,
    remaining: r[1],
    retryAfterMs: r[2],
    resetMs: r[3],
  };
}

module.exports = { check, ALGORITHMS };
