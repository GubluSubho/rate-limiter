const path = require("path");
const express = require("express");
const { rateLimiter } = require("./limiter");
const { redis } = require("./redis");

const app = express();
// Allow requests from the Vercel dashboard
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin === "https://rate-limiter-omega.vercel.app") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});
app.set("trust proxy", true);

// Demo API keys mapped to tiers
const TIERS = {
  "free-key-123": { name: "free", limit: 20 },
  "pro-key-456": { name: "pro", limit: 100 },
};
const tierLimit = (req) => {
  const tier = TIERS[req.headers["x-api-key"]];
  return tier ? tier.limit : 10; // anonymous = 10
};

// Dashboard (static files, registered before the limiter so it is never limited)
app.use("/dashboard", express.static(path.join(__dirname, "..", "public")));

// Unlimited operational endpoints (registered before the global limiter)
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/metrics", async (req, res) => {
  try {
    res.json(await redis.hgetall("rl:stats"));
  } catch (e) {
    res.status(503).json({ error: "metrics unavailable" });
  }
});

// Global: sliding window counter, tiered per API key (per minute)
app.use(
  rateLimiter({
    algorithm: "sliding-window-counter",
    limit: tierLimit,
    windowMs: 60000,
    keyPrefix: "global",
  })
);

app.get("/", (req, res) => res.json({ message: "Request allowed" }));

// Token bucket: burst of 5, then refills 5 per minute. Fail-closed (503) if Redis is down.
app.post(
  "/login",
  rateLimiter({
    algorithm: "token-bucket",
    limit: 5,
    windowMs: 60000,
    keyPrefix: "login",
    failOpen: false,
  }),
  (req, res) => res.json({ message: "Login attempt processed" })
);

// Sliding window log: exactly 5 requests per 10 seconds
app.get(
  "/search",
  rateLimiter({
    algorithm: "sliding-window-log",
    limit: 5,
    windowMs: 10000,
    keyPrefix: "search",
  }),
  (req, res) => res.json({ results: [] })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on http://localhost:" + PORT));
