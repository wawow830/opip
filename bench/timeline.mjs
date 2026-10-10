#!/usr/bin/env node
// Print idle gaps in a .cpuprofile with the JS stack right before/after each gap.
import { readFileSync } from "node:fs";
const prof = JSON.parse(readFileSync(process.argv[2], "utf8"));
const minGapMs = Number(process.argv[3] ?? 5);
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const stack = (id) => {
  const s = [];
  for (let p = id; p != null; p = parent.get(p)) {
    const f = nodes.get(p).callFrame;
    if (f.functionName === "(root)") continue;
    s.push(`${f.functionName || "(anon)"}@${f.url.split("/").pop()}:${f.lineNumber}`);
  }
  return s.slice(0, 8).join(" < ");
};
let t = 0, gapStart = null, before = null;
for (let i = 0; i < prof.samples.length; i++) {
  t += prof.timeDeltas[i];
  const n = nodes.get(prof.samples[i]);
  const idle = n.callFrame.functionName === "(idle)";
  if (idle && gapStart == null) { gapStart = t; before = prof.samples[i - 1]; }
  if (!idle && gapStart != null) {
    const ms = (t - gapStart) / 1000;
    if (ms >= minGapMs) {
      console.log(`@${(gapStart / 1000).toFixed(0)}ms idle ${ms.toFixed(0)}ms`);
      console.log(`   before: ${before ? stack(before) : "-"}`);
      console.log(`   after:  ${stack(prof.samples[i])}`);
    }
    gapStart = null;
  }
}
console.log(`end @${(t / 1000).toFixed(0)}ms`);
