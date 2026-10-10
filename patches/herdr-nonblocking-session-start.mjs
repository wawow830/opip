#!/usr/bin/env node
// Re-apply the opip fix to herdr's managed pi integration (herdr overwrites it on reinstall/update).
//
// Problem: the integration's session_start handler awaits a herdr socket round-trip, and Pi waits for
// session_start handlers before its first interactive frame. herdr 0.9.3 answers any request whose bytes
// arrive after accept() on a ~100ms poll tick, so every Pi startup stalled ~100ms.
// Fix: publish asynchronously, keeping the order (session report, then state).
//
// Usage: node patches/herdr-nonblocking-session-start.mjs [path]   (idempotent)
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const file = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/herdr-agent-state.ts");
const src = readFileSync(file, "utf8");
const MARK = "opip: don't block Pi startup";

if (src.includes(MARK)) {
  console.log(`already patched: ${file}`);
  process.exit(0);
}

const before = /( *)await reportSession\(event\?\.reason\);\n\s*\/\/ A reload can replace this extension mid-run without emitting another agent_start\.\n\s*agentActive = ctx\?\.isIdle\?\.\(\) === false;\n\s*publishState\(true\);/;
const m = src.match(before);
if (!m) {
  console.error(`pattern not found in ${file}; herdr integration changed — inspect manually.`);
  process.exit(1);
}
const i = m[1];
const after =
  `${i}// A reload can replace this extension mid-run without emitting another agent_start.\n` +
  `${i}agentActive = ctx?.isIdle?.() === false;\n` +
  `${i}// ${MARK} on the herdr round-trip (herdr answers late-arriving\n` +
  `${i}// requests on a ~100ms poll tick). Ordering is kept: state is published after the session report.\n` +
  `${i}void reportSession(event?.reason).then(() => publishState(true));`;
writeFileSync(file, src.replace(before, after));
console.log(`patched: ${file}`);
