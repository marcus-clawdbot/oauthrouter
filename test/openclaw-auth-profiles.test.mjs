import test from "node:test";
import assert from "node:assert/strict";

import {
  parseOpenClawAuthProfileStoreJson,
  resolveBestProfileIdForProvider,
  resolveBearerTokenForProvider,
} from "../dist/index.js";

test("prefers lastGood[anthropic] when present", () => {
  const json = JSON.stringify({
    version: 1,
    profiles: {
      "anthropic:work": { type: "token", provider: "anthropic", token: "tok_work" },
      "anthropic:personal": { type: "token", provider: "anthropic", token: "tok_personal" },
    },
    lastGood: { anthropic: "anthropic:personal" },
    order: { anthropic: ["anthropic:work", "anthropic:personal"] },
  });

  const store = parseOpenClawAuthProfileStoreJson(json);
  assert.equal(resolveBestProfileIdForProvider(store, "anthropic"), "anthropic:personal");
  assert.deepEqual(resolveBearerTokenForProvider(store, "anthropic"), {
    profileId: "anthropic:personal",
    token: "tok_personal",
  });
});

test("falls back to order[anthropic] when lastGood missing", () => {
  const json = JSON.stringify({
    version: 1,
    profiles: {
      "anthropic:a": { type: "token", provider: "anthropic", token: "A" },
      "anthropic:b": { type: "token", provider: "anthropic", token: "B" },
    },
    order: { anthropic: ["anthropic:b", "anthropic:a"] },
  });

  const store = parseOpenClawAuthProfileStoreJson(json);
  assert.equal(resolveBestProfileIdForProvider(store, "anthropic"), "anthropic:b");
});

test("supports legacy store format (top-level profileId map)", () => {
  const json = JSON.stringify({
    "anthropic:default": { type: "token", provider: "anthropic", token: "LEGACY" },
  });

  const store = parseOpenClawAuthProfileStoreJson(json);
  assert.equal(resolveBestProfileIdForProvider(store, "anthropic"), "anthropic:default");
  assert.deepEqual(resolveBearerTokenForProvider(store, "anthropic"), {
    profileId: "anthropic:default",
    token: "LEGACY",
  });
});

test("trims token values", () => {
  const json = JSON.stringify({
    profiles: {
      "anthropic:default": { type: "token", provider: "anthropic", token: "  x  " },
    },
  });

  const store = parseOpenClawAuthProfileStoreJson(json);
  assert.equal(resolveBearerTokenForProvider(store, "anthropic").token, "x");
});

test("accepts api_key credential as bearer token (compat)", () => {
  const json = JSON.stringify({
    profiles: {
      "anthropic:default": { type: "api_key", provider: "anthropic", apiKey: "k" },
    },
  });

  const store = parseOpenClawAuthProfileStoreJson(json);
  assert.equal(resolveBearerTokenForProvider(store, "anthropic").token, "k");
});
