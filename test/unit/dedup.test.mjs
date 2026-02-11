import test from "node:test";
import assert from "node:assert/strict";
import { RequestDeduplicator } from "../../dist/index.js";

// ─── hash ───

test("produces consistent hash for same JSON body", () => {
  const body = Buffer.from(
    JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "Hi" }] }),
  );
  const h1 = RequestDeduplicator.hash(body);
  const h2 = RequestDeduplicator.hash(body);
  assert.equal(h1, h2);
});

test("produces same hash regardless of key order", () => {
  const body1 = Buffer.from(JSON.stringify({ a: 1, b: 2 }));
  const body2 = Buffer.from(JSON.stringify({ b: 2, a: 1 }));
  assert.equal(RequestDeduplicator.hash(body1), RequestDeduplicator.hash(body2));
});

test("strips OpenClaw timestamps for consistent hash", () => {
  const body1 = Buffer.from(
    JSON.stringify({
      messages: [{ role: "user", content: "[SUN 2026-02-07 13:30 PST] Hello" }],
    }),
  );
  const body2 = Buffer.from(
    JSON.stringify({
      messages: [{ role: "user", content: "[MON 2026-02-08 09:00 UTC] Hello" }],
    }),
  );
  assert.equal(RequestDeduplicator.hash(body1), RequestDeduplicator.hash(body2));
});

test("different content produces different hash", () => {
  const body1 = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }));
  const body2 = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "Goodbye" }] }));
  assert.notEqual(RequestDeduplicator.hash(body1), RequestDeduplicator.hash(body2));
});

test("handles non-JSON body gracefully", () => {
  const body = Buffer.from("this is not JSON");
  const hash = RequestDeduplicator.hash(body);
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 16);
});

// ─── cache lifecycle ───

test("getCached returns undefined for unknown key", () => {
  const dedup = new RequestDeduplicator();
  assert.equal(dedup.getCached("unknown"), undefined);
});

test("complete stores and getCached retrieves", () => {
  const dedup = new RequestDeduplicator();
  const key = "test-key";
  const result = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from("ok"),
    completedAt: Date.now(),
  };
  dedup.complete(key, result);
  const cached = dedup.getCached(key);
  assert.ok(cached);
  assert.equal(cached.status, 200);
  assert.equal(cached.body.toString(), "ok");
});

test("expired entries are pruned", () => {
  const dedup = new RequestDeduplicator(1); // 1ms TTL
  const key = "expire-key";
  const result = {
    status: 200,
    headers: {},
    body: Buffer.from("data"),
    completedAt: Date.now() - 100, // already expired
  };
  dedup.complete(key, result);
  // Should be expired
  assert.equal(dedup.getCached(key), undefined);
});

// ─── inflight tracking ───

test("markInflight and getInflight", () => {
  const dedup = new RequestDeduplicator();
  const key = "inflight-key";
  dedup.markInflight(key);
  const promise = dedup.getInflight(key);
  assert.ok(promise instanceof Promise);
});

test("getInflight returns undefined when not inflight", () => {
  const dedup = new RequestDeduplicator();
  assert.equal(dedup.getInflight("nope"), undefined);
});

test("removeInflight clears inflight entry", () => {
  const dedup = new RequestDeduplicator();
  const key = "remove-key";
  dedup.markInflight(key);
  dedup.removeInflight(key);
  assert.equal(dedup.getInflight(key), undefined);
});

test("does not cache responses over 1MB", () => {
  const dedup = new RequestDeduplicator();
  const key = "big-key";
  const result = {
    status: 200,
    headers: {},
    body: Buffer.alloc(1_048_577), // Just over 1MB
    completedAt: Date.now(),
  };
  dedup.complete(key, result);
  assert.equal(dedup.getCached(key), undefined);
});
