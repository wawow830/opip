import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
// Public entrypoint aliased by Pi's extension loader.
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "cliproxy";
export const PROVIDER_NAME = "CLIProxyAPI";

export interface CliproxyOptions {
  /** CPA server root, without /v1. */
  root: string;
  apiKey: string;
  /** Model ID cache used when CPA is unreachable. */
  cachePath: string;
}

export function resolveOptions(env: NodeJS.ProcessEnv = process.env): CliproxyOptions {
  const configPath = env.CLIPROXY_CONFIG ?? join(homedir(), ".config/cli-proxy-api/config.yaml");
  return {
    root: (env.CLIPROXY_BASE_URL ?? "http://127.0.0.1:8317").replace(/\/+$/, ""),
    apiKey: env.CLIPROXY_API_KEY ?? readConfigApiKey(configPath) ?? "cliproxy",
    cachePath: env.CLIPROXY_MODELS_CACHE ?? join(homedir(), ".pi/agent/cliproxy-models.json"),
  };
}

/** First entry of `access.api-keys` in a CPA config.yaml. */
export function parseConfigApiKey(yaml: string): string | undefined {
  const block = yaml.match(/^access:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+api-keys:[ \t]*\r?\n((?:[ \t]+-.*(?:\r?\n|$))+)/m)?.[1];
  return block?.match(/-\s*["']?([^"'\s#]+)/)?.[1];
}

function readConfigApiKey(path: string): string | undefined {
  try {
    return parseConfigApiKey(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

interface Family { match: RegExp; api: Api; path: string; catalogs: BuiltinProvider[] }
// Each family goes to the CPA endpoint that speaks its native protocol.
const FAMILIES: Family[] = [
  { match: /^claude/i, api: "anthropic-messages", path: "", catalogs: ["anthropic"] },
  { match: /^(gpt|o\d|codex)/i, api: "openai-responses", path: "/v1", catalogs: ["openai-codex", "openai"] },
  { match: /^gemini/i, api: "google-generative-ai", path: "/v1beta", catalogs: ["google"] },
  { match: /^grok/i, api: "openai-responses", path: "/v1", catalogs: ["xai"] },
];
const FALLBACK: Family = { match: /./, api: "openai-completions", path: "/v1", catalogs: [] };
const SEARCH: BuiltinProvider[] = ["anthropic", "openai", "openai-codex", "google", "xai", "moonshotai", "zai", "deepseek", "openrouter"];
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const norm = (id: string) =>
  id.toLowerCase().replace(/\./g, "-").replace(/-(thinking|minimal|low|medium|high|xhigh)$/, "");

function catalog(provider: BuiltinProvider): Model<Api>[] {
  try {
    return getBuiltinModels(provider) as Model<Api>[];
  } catch {
    return [];
  }
}

const exact = (id: string) => id;
const undated = (id: string) => id.replace(/-\d{8}$/, "");

/**
 * Lookup table for one catalog pool under one key function: maps every ID a model answers to
 * (its full key, plus each suffix after a "/") to the first such model in pool order. Equivalent to
 * `pool.find((m) => k === want || k.endsWith(`/${want}`))` but built once instead of scanned per ID,
 * which keeps Pi startup from re-normalizing every catalog entry for every CPA model.
 */
type PoolIndex = Map<string, Model<Api>>;
const indexes = new Map<string, PoolIndex>();

function poolIndex(name: string, models: () => Model<Api>[], key: (id: string) => string): PoolIndex {
  const cacheKey = `${name}\0${key === exact ? "exact" : "undated"}`;
  let index = indexes.get(cacheKey);
  if (index) return index;
  index = new Map();
  for (const m of models()) {
    const k = key(norm(m.id));
    if (!index.has(k)) index.set(k, m);
    for (let i = k.indexOf("/"); i !== -1; i = k.indexOf("/", i + 1)) {
      const suffix = k.slice(i + 1);
      if (!index.has(suffix)) index.set(suffix, m);
    }
  }
  indexes.set(cacheKey, index);
  return index;
}

export function catalogModel(id: string, preferred: BuiltinProvider[] = []): Model<Api> | undefined {
  const pools: [string, () => Model<Api>[]][] = [
    ...preferred.map((p): [string, () => Model<Api>[]] => [p, () => catalog(p)]),
    ["*", () => SEARCH.flatMap(catalog)],
  ];
  // Exact first, then ignoring date suffixes (claude-opus-4-1-20250805 ~ anthropic/claude-opus-4.1).
  for (const key of [exact, undated]) {
    const want = key(norm(id));
    for (const [name, models] of pools) {
      const hit = poolIndex(name, models, key).get(want);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function toModel(id: string, root: string): ProviderModelConfig {
  const fam = FAMILIES.find((f) => f.match.test(id)) ?? FALLBACK;
  const base = catalogModel(id, fam.catalogs);
  const model: ProviderModelConfig = {
    id,
    name: `${base?.name ?? id} (CPA)`,
    api: fam.api,
    baseUrl: root + fam.path,
    reasoning: base?.reasoning ?? /thinking|reason|^o\d|gpt-[5-9]/i.test(id),
    input: base?.input ?? ["text"],
    // API-equivalent pricing (what the usage would cost on the pay-as-you-go API).
    cost: base?.cost ?? ZERO_COST,
    contextWindow: base?.contextWindow ?? 128_000,
    maxTokens: base?.maxTokens ?? 16_384,
  };
  if (base?.thinkingLevelMap) model.thinkingLevelMap = base.thinkingLevelMap;
  if (base?.inputLimits) model.inputLimits = base.inputLimits;
  if (base?.promptCache) model.promptCache = base.promptCache;
  // Claude compat flags describe model behavior CPA passes through; fallbacks target
  // the built-in anthropic provider, so drop them.
  if (fam.api === "anthropic-messages" && base?.compat) {
    const { allowedFallbackModels: _, ...compat } = base.compat as Record<string, unknown>;
    model.compat = compat as ProviderModelConfig["compat"];
  }
  return model;
}

// Blocking first-run fetch, /model refresh, and the non-blocking startup refresh.
const TIMEOUT = { firstRun: 1500, refresh: 3000, background: 5000 };

export async function fetchModelIds(opts: CliproxyOptions, signal?: AbortSignal, timeoutMs = TIMEOUT.refresh): Promise<string[]> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${opts.root}/v1/models`, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`CLIProxyAPI /v1/models: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].sort();
}

export function readCache(path: string): string[] {
  try {
    const ids = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeCache(path: string, ids: string[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Atomic replace: concurrent Pi instances never read a half-written file.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ids));
    renameSync(tmp, path);
  } catch {}
}

/** Fetch live IDs and cache them; undefined when CPA is unreachable. */
async function fetchAndCache(opts: CliproxyOptions, signal?: AbortSignal, timeoutMs?: number): Promise<string[] | undefined> {
  try {
    const ids = await fetchModelIds(opts, signal, timeoutMs);
    writeCache(opts.cachePath, ids);
    return ids;
  } catch {
    return undefined;
  }
}

/** Live model list, falling back to the last successful list. */
export async function loadModels(opts: CliproxyOptions, signal?: AbortSignal, allowNetwork = true): Promise<ProviderModelConfig[]> {
  const ids = (allowNetwork && (await fetchAndCache(opts, signal))) || readCache(opts.cachePath);
  return ids.map((id) => toModel(id, opts.root));
}

export function cliproxyProvider(ids: string[], opts: CliproxyOptions = resolveOptions()): ProviderConfig {
  return {
    name: PROVIDER_NAME,
    baseUrl: `${opts.root}/v1`,
    api: "openai-completions",
    apiKey: opts.apiKey,
    models: ids.map((id) => toModel(id, opts.root)),
    refreshModels: (ctx) => loadModels(opts, ctx.signal, ctx.allowNetwork),
  };
}

/**
 * Snapshot-first startup: register the cached list immediately, then refresh in the
 * background and re-register only if CPA's list changed. Only a first run (no cache)
 * waits on the network. Resolves once the provider is registered; the returned
 * `refreshed` promise settles when the background refresh finishes.
 */
export async function registerCliproxy(
  register: (config: ProviderConfig) => void,
  opts: CliproxyOptions = resolveOptions(),
): Promise<{ refreshed: Promise<void> }> {
  const cached = readCache(opts.cachePath);
  if (cached.length === 0) {
    register(cliproxyProvider((await fetchAndCache(opts, undefined, TIMEOUT.firstRun)) ?? [], opts));
    return { refreshed: Promise.resolve() };
  }
  register(cliproxyProvider(cached, opts));
  const refreshed = fetchAndCache(opts, undefined, TIMEOUT.background).then((ids) => {
    if (ids && ids.join("\n") !== cached.join("\n")) register(cliproxyProvider(ids, opts));
  });
  return { refreshed };
}
