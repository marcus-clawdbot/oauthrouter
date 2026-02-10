import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { ProviderHealthManager, tierFromModelId } from "../../dist/index.js";

function tmpPath(name) {
  return path.join(
    os.tmpdir(),
    `oauthrouter-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

test("tierFromModelId maps known families", () => {
  assert.equal(tierFromModelId("anthropic/claude-haiku-4-5"), "SIMPLE");
  assert.equal(tierFromModelId("anthropic/claude-sonnet-4-5"), "MEDIUM");
  assert.equal(tierFromModelId("anthropic/claude-opus-4-6"), "COMPLEX");
  assert.equal(tierFromModelId("deepseek/deepseek-reasoner"), "REASONING");
  assert.equal(tierFromModelId("openai-codex/gpt-5.2"), "MEDIUM");
});

test("ProviderHealthManager records cooldown on 429 and persists", async () => {
  const p = tmpPath("provider-health");
  const mgr = new ProviderHealthManager({
    persistPath: p,
    baseCooldownMs: 5000,
    maxCooldownMs: 30_000,
  });

  mgr.recordResult("anthropic", "SIMPLE", 429, 50);
  assert.equal(mgr.isInCooldown("anthropic", "SIMPLE"), true);

  // Wait for debounce flush.
  await new Promise((r) => setTimeout(r, 650));
  assert.ok(fs.existsSync(p));

  const mgr2 = new ProviderHealthManager({
    persistPath: p,
    baseCooldownMs: 100,
    maxCooldownMs: 1000,
  });
  assert.equal(mgr2.isInCooldown("anthropic", "SIMPLE"), true);
});
