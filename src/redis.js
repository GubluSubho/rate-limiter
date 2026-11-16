const Redis = require("ioredis");

// Fail fast when Redis is down so the limiter can use its fallback
// instead of hanging every request.
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 500,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

let lastLog = 0;
redis.on("error", (err) => {
  if (Date.now() - lastLog > 5000) {
    console.error("[redis]", err.message);
    lastLog = Date.now();
  }
});

function ready() {
  return new Promise((resolve) => {
    if (redis.status === "ready") return resolve();
    redis.once("ready", resolve);
  });
}

module.exports = { redis, ready };
