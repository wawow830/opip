import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { loadModels, parseConfigApiKey, registerCliproxy, toModel } from "../src/cliproxy/provider.ts";

const root = "http://127.0.0.1:8317";
const dir = mkdtempSync(join(tmpdir(), "pi-cliproxy-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("parses first access api key from CPA config", () => {
  const yaml = `server:\n  port: 8317\naccess:\n  api-keys:\n    - "sk-one" # comment\n    - 'sk-two'\nrouting:\n  strategy: x\n`;
  assert.equal(parseConfigApiKey(yaml), "sk-one");
  assert.equal(parseConfigApiKey("access:\n  api-keys:\n    - bare-key"), "bare-key");
  assert.equal(parseConfigApiKey("access:\n  api-keys: []\n"), undefined);
});

test("routes model families to native CPA endpoints", () => {
  const claude = toModel("claude-opus-5-5", root);
  assert.equal(claude.api, "anthropic-messages");
  assert.equal(claude.baseUrl, root);
  assert.equal((claude.compat as Record<string, unknown> | undefined)?.allowedFallbackModels, undefined);

  assert.deepEqual([toModel("gpt-6-astra", root).api, toModel("gpt-6-astra", root).baseUrl], ["openai-responses", `${root}/v1`]);
  assert.deepEqual([toModel("gemini-2.5-pro", root).api, toModel("gemini-2.5-pro", root).baseUrl], ["google-generative-ai", `${root}/v1beta`]);
  assert.equal(toModel("grok-4.5", root).api, "openai-responses");
  assert.equal(toModel("some-other", root).api, "openai-completions");
});

test("uses catalog metadata, API-equivalent cost, and safe defaults", () => {
  const known = toModel("gemini-2.5-pro", root);
  assert.ok(known.contextWindow > 128_000);
  assert.ok(known.input.includes("image"));
  assert.ok(known.cost.input > 0 && known.cost.output > 0);
  assert.ok(toModel("gpt-6-astra", root).cost.tiers?.length);
  assert.match(known.name, /\(CPA\)$/);

  const unknown = toModel("mystery-model", root);
  assert.deepEqual([unknown.contextWindow, unknown.maxTokens, unknown.reasoning, unknown.input], [128_000, 16_384, false, ["text"]]);
  assert.deepEqual(unknown.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  // thinking-suffixed variants still find catalog metadata
  assert.equal(toModel("claude-opus-5-5-thinking", root).contextWindow, toModel("claude-opus-5-5", root).contextWindow);
  // dated IDs missing from the Anthropic catalog still get metadata from other catalogs
  const dated = toModel("claude-opus-4-1-20250805", root);
  assert.equal(dated.api, "anthropic-messages");
  assert.ok(dated.reasoning && dated.input.includes("image") && dated.contextWindow >= 200_000);
});

async function fakeCpa(ids: () => unknown[]) {
  const seen = { auth: undefined as string | undefined, hits: 0 };
  const server = createServer((req, res) => {
    seen.auth = req.headers.authorization;
    seen.hits++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: ids() }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { root, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function startup(opts: { root: string; apiKey: string; cachePath: string }) {
  const registered: string[][] = [];
  const { refreshed } = await registerCliproxy((c: ProviderConfig) => registered.push(c.models!.map((m) => m.id)), opts);
  return { registered, refreshed };
}

test("discovers models, caches them, and falls back when offline", async () => {
  const cpa = await fakeCpa(() => [{ id: "gpt-6-astra" }, { id: "claude-opus-5-5" }, { id: "gpt-6-astra" }, { nope: 1 }]);
  const live = { root: cpa.root, apiKey: "sk-test", cachePath: join(dir, "c.json") };

  // First run (no cache): waits for CPA once.
  const first = await startup(live);
  assert.equal(cpa.seen.auth, "Bearer sk-test");
  assert.deepEqual(first.registered, [["claude-opus-5-5", "gpt-6-astra"]]);
  assert.deepEqual(JSON.parse(readFileSync(live.cachePath, "utf8")), ["claude-opus-5-5", "gpt-6-astra"]);
  assert.equal((await loadModels(live))[0].baseUrl, live.root);
  await cpa.close();

  const offline = { ...live, root: "http://127.0.0.1:1" };
  assert.deepEqual((await loadModels(offline)).map((m) => m.id), ["claude-opus-5-5", "gpt-6-astra"]);
  assert.deepEqual((await loadModels({ ...offline, cachePath: join(dir, "missing.json") })).length, 0);
  assert.equal((await loadModels(live, undefined, false)).length, 2); // no network: cache only

  // CPA down at startup: cached list registers without a re-register.
  const down = await startup(offline);
  await down.refreshed;
  assert.deepEqual(down.registered, [["claude-opus-5-5", "gpt-6-astra"]]);
});

test("registers the snapshot first and re-registers only when CPA's list changed", async () => {
  let ids = [{ id: "claude-opus-5-5" }];
  const cpa = await fakeCpa(() => ids);
  const opts = { root: cpa.root, apiKey: "k", cachePath: join(dir, "snap.json") };
  writeFileSync(opts.cachePath, JSON.stringify(["claude-opus-5-5"]));

  // Unchanged: one registration, before the network answers.
  const same = await startup(opts);
  assert.deepEqual(same.registered, [["claude-opus-5-5"]]);
  await same.refreshed;
  assert.equal(same.registered.length, 1);
  assert.equal(cpa.seen.hits, 1);

  // Changed: cached list first, then the live list, and the cache is updated.
  ids = [{ id: "claude-opus-5-5" }, { id: "gpt-6-astra" }];
  const changed = await startup(opts);
  assert.deepEqual(changed.registered, [["claude-opus-5-5"]]);
  await changed.refreshed;
  assert.deepEqual(changed.registered, [["claude-opus-5-5"], ["claude-opus-5-5", "gpt-6-astra"]]);
  assert.deepEqual(JSON.parse(readFileSync(opts.cachePath, "utf8")), ["claude-opus-5-5", "gpt-6-astra"]);
  await cpa.close();
});
