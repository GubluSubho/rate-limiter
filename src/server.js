
const path = require("path");
const express = require("express");
const { rateLimiter } = require("./limiter");
const { redis } = require("./redis");

const app = express();
console.log("RUNNING UPDATED SERVER WITH CORS FIX - VERSION 2");

app.set("trust proxy", true);

// CORS middleware — must be before all routes and rate limiters
app.use((req, res, next) => {
  const allowedOrigin = "https://rate-limiter-omega.vercel.app";
  const origin = req.headers.origin;

  if (origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, x-api-key"
    );

    res.setHeader(
      "Access-Control-Expose-Headers",
      "RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After"
    );
  }

  // Handle browser preflight requests before rate limiting
  if (req.method === "OPTIONS") {
    return res.sendStatus(origin === allowedOrigin ? 204 : 403);
  }

  next();
});

// Demo API keys mapped to tiers
const TIERS = {
  "free-key-123": { name: "free", limit: 20 },
  "pro-key-456": { name: "pro", limit: 100 },
};

// Anonymous users get a limit of 10 requests per minute
const tierLimit = (req) => {
  const tier = TIERS[req.headers["x-api-key"]];
  return tier ? tier.limit : 10;
};

// Dashboard static files
app.use(
  "/dashboard",
  express.static(path.join(__dirname, "..", "public"))
);

// Health endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Redis metrics endpoint
app.get("/metrics", async (req, res) => {
  try {
    const metrics = await redis.hgetall("rl:stats");
    res.json(metrics);
  } catch (error) {
    console.error("[metrics]", error.message);
    res.status(503).json({ error: "metrics unavailable" });
  }
});

// Global sliding-window-counter rate limiter
app.use(
  rateLimiter({
    algorithm: "sliding-window-counter",
    limit: tierLimit,
    windowMs: 60000,
    keyPrefix: "global",
  })
);

// Default API endpoint
app.get("/", (req, res) => {
  res.json({ message: "Request allowed" });
});

// Login endpoint — token bucket algorithm
app.post(
  "/login",
  rateLimiter({
    algorithm: "token-bucket",
    limit: 5,
    windowMs: 60000,
    keyPrefix: "login",
    failOpen: false,
  }),
  (req, res) => {
    res.json({ message: "Login attempt processed" });
  }
);

// Search endpoint — sliding-window-log algorithm
app.get(
  "/search",
  rateLimiter({
    algorithm: "sliding-window-log",
    limit: 5,
    windowMs: 10000,
    keyPrefix: "search",
  }),
  (req, res) => {
    res.json({ results: [] });
  }
);

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
