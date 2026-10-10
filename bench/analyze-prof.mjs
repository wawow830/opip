#!/usr/bin/env node
// Summarize a .cpuprofile: self time by function, by file, and inclusive time for top frames.
import { readFileSync } from "node:fs";
const prof = JSON.parse(readFileSync(process.argv[2], "utf8"));
const top = Number(process.argv[3] ?? 40);
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map();
const dts = prof.timeDeltas;
for (let i = 0; i < prof.samples.length; i++) self.set(prof.samples[i], (self.get(prof.samples[i]) ?? 0) + (dts[i] ?? 0));
const totalUs = dts.reduce((a, b) => a + b, 0);
const key = (n) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber}`;
const byFn = new Map(), byFile = new Map(), incl = new Map();
for (const [id, us] of self) {
  const n = nodes.get(id);
  byFn.set(key(n), (byFn.get(key(n)) ?? 0) + us);
  const f = n.callFrame.url.split("/").slice(-2).join("/") || n.callFrame.functionName;
  byFile.set(f, (byFile.get(f) ?? 0) + us);
  const seen = new Set();
  for (let p = id; p != null; p = parent.get(p)) {
    const k = key(nodes.get(p));
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + us);
  }
}
const show = (title, m) => {
  console.log(`\n== ${title} ==`);
  for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(v / 1000).toFixed(1).padStart(8)}ms  ${k}`);
};
console.log(`total sampled: ${(totalUs / 1000).toFixed(0)}ms`);
show("self by file", byFile);
show("self by function", byFn);
show("inclusive", incl);
