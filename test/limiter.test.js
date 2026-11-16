const test = require("node:test");
const assert = require("node:assert");
const { check } = require("../src/algorithms");
const { redis, ready } = require("../src/redis");

const uid = () => "test:" + Date.now() + ":" + Math.random();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(ready);
test.after(() => redis.quit());

test("sliding-window-log blocks after limit and recovers", async () => {
  const key = uid();
  const opts = { limit: 3, windowMs: 1000 };
  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await check("sliding-window-log", key, opts)).allowed, true);
  }
  const blocked = await check("sliding-window-log", key, opts);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  await sleep(1100);
  assert.strictEqual((await check("sliding-window-log", key, opts)).allowed, true);
});

test("token-bucket allows a burst then refills", async () => {
  const key = uid();
  const opts = { limit: 5, windowMs: 1000 }; // 5 tokens, refills 5 per second
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await check("token-bucket", key, opts)).allowed, true);
  }
  assert.strictEqual((await check("token-bucket", key, opts)).allowed, false);
  await sleep(400); // about 2 tokens back
  assert.strictEqual((await check("token-bucket", key, opts)).allowed, true);
});

test("sliding-window-counter blocks after limit", async () => {
  const key = uid();
  const opts = { limit: 4, windowMs: 60000 };
  let allowed = 0;
  for (let i = 0; i < 8; i++) {
    if ((await check("sliding-window-counter", key, opts)).allowed) allowed++;
  }
  assert.strictEqual(allowed, 4);
});

test("atomic under concurrency: 100 parallel requests, limit 10 -> exactly 10 allowed", async () => {
  for (const algo of ["token-bucket", "sliding-window-log", "sliding-window-counter"]) {
    const key = uid();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => check(algo, key, { limit: 10, windowMs: 60000 }))
    );
    assert.strictEqual(results.filter((r) => r.allowed).length, 10, algo);
  }
});

test("different clients have independent limits", async () => {
  const a = uid();
  const b = uid();
  const opts = { limit: 1, windowMs: 60000 };
  await check("sliding-window-log", a, opts);
  assert.strictEqual((await check("sliding-window-log", a, opts)).allowed, false);
  assert.strictEqual((await check("sliding-window-log", b, opts)).allowed, true);
});
