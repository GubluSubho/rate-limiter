# Distributed Rate Limiter (Node.js + Redis)

Three algorithms, each implemented as an atomic Redis Lua script:
- Token bucket (hash): burst-friendly
- Sliding window log (sorted set): exact
- Sliding window counter (two counters): low memory, approximate

## Run
1. Start a Redis-compatible server on port 6379 (Redis, or Memurai on Windows)
2. npm install
3. npm test
4. npm start

## Endpoints
- GET /          global limit, tiered per API key (anonymous 10, free 20, pro 100 per minute)
- POST /login    token bucket, burst of 5, fail-closed (503 if Redis is down)
- GET /search    sliding window log, 5 per 10 seconds
- GET /health    unlimited
- GET /metrics   allowed and blocked counters

## Design notes
- Lua scripts make check and update atomic, so there are no race conditions
- Time comes from Redis TIME, so app-server clock differences do not matter
- Keys get a TTL so idle clients are cleaned up automatically
- Per-route algorithm and per-API-key tiers
- Fail-open with in-memory fallback, or fail-closed (503) for sensitive routes
