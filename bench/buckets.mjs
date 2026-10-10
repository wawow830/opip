#!/usr/bin/env node
// buckets.mjs <cpuprofile> [bucketMs=10] — for each time bucket, list the dominant "named" frames
// (closest-to-root application frame that's interesting) so you can see startup phases.
import { readFileSync } from "node:fs";
const prof = JSON.parse(readFileSync(process.argv[2], "utf8"));
const B = Number(process.argv[3] ?? 10) * 1000;
const depthArg = Number(process.argv[4] ?? 3);
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const label = (id) => {
  const chain = [];
  for (let p = id; p != null; p = parent.get(p)) chain.unshift(nodes.get(p).callFrame);
  const special = chain[chain.length - 1];
  if (["(idle)", "(garbage collector)", "(program)"].includes(special.functionName)) return special.functionName;
  // keep named app frames (skip node internals and anonymous module bodies)
  const app = chain.filter((f) => f.url && !f.url.startsWith("node:") && f.functionName && f.functionName !== "(anon)");
  const pick = app.slice(0, depthArg).map((f) => `${f.functionName}`);
  const mod = chain.filter((f) => /chunks|src|node_modules|extensions/.test(f.url)).pop();
  return (pick.join(">") || "(load)") + (mod ? ` [${mod.url.split("/").pop()}]` : "");
};
let t = 0;
const buckets = [];
for (let i = 0; i < prof.samples.length; i++) {
  t += prof.timeDeltas[i];
  const b = Math.floor(t / B);
  (buckets[b] ??= new Map());
  const l = label(prof.samples[i]);
  buckets[b].set(l, (buckets[b].get(l) ?? 0) + (prof.timeDeltas[i] ?? 0));
}
buckets.forEach((m, i) => {
  if (!m) return;
  const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${(v / 1000).toFixed(0)}ms`);
  console.log(`${String(i * B / 1000).padStart(5)}ms | ${top.join(" | ")}`);
});
