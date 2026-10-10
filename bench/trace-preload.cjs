// Preload (node --require) that logs async waits during pi startup to $PI_TRACE_FILE.
// Logs: timers >= 10ms, net connections, child processes, fetch calls. Timestamps are ms since process start.
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const file = process.env.PI_TRACE_FILE || "/tmp/pi-trace.log";
const fd = fs.openSync(file, "w");
const now = () => performance.now().toFixed(1).padStart(7);
const site = () => {
  const s = new Error().stack.split("\n").slice(3, 7).map((l) => l.trim().replace(/^at /, "").replace(/\(file:\/\/.*\/(chunks\/)?/, "(")).join(" < ");
  return s.length > 300 ? s.slice(0, 300) : s;
};
const log = (msg) => fs.writeSync(fd, `${now()} ${msg}\n`);

const origSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms, ...args) {
  if (ms >= 10) {
    const where = site();
    log(`setTimeout(${ms}) @ ${where}`);
    const wrapped = (...a) => { log(`  fired setTimeout(${ms}) @ ${where.slice(0, 120)}`); return fn(...a); };
    return origSetTimeout.call(this, wrapped, ms, ...args);
  }
  return origSetTimeout.call(this, fn, ms, ...args);
};

const net = require("node:net");
const origCreate = net.createConnection;
net.createConnection = net.connect = function (...a) {
  const target = typeof a[0] === "string" ? a[0] : JSON.stringify(a[0]).slice(0, 80);
  const where = site();
  log(`net.connect ${target} @ ${where}`);
  const s = origCreate.apply(this, a);
  s.on("connect", () => log(`  connected ${target}`));
  s.on("data", (d) => log(`  data ${target} ${d.length}B`));
  s.on("close", () => log(`  close ${target}`));
  return s;
};

const cp = require("node:child_process");
for (const name of ["spawn", "execFile", "exec"]) {
  const orig = cp[name];
  cp[name] = function (...a) {
    const where = site();
    const t0 = performance.now();
    log(`${name} ${String(a[0]).slice(0, 60)} ${Array.isArray(a[1]) ? a[1].join(" ").slice(0, 80) : ""} @ ${where}`);
    const child = orig.apply(this, a);
    child.on?.("exit", (c) => log(`  exit ${String(a[0]).slice(0, 40)} code=${c} after ${(performance.now() - t0).toFixed(1)}ms`));
    return child;
  };
}
for (const name of ["spawnSync", "execFileSync", "execSync"]) {
  const orig = cp[name];
  cp[name] = function (...a) {
    const t0 = performance.now();
    const r = orig.apply(this, a);
    log(`${name} ${String(a[0]).slice(0, 60)} ${Array.isArray(a[1]) ? a[1].join(" ").slice(0, 60) : ""} took ${(performance.now() - t0).toFixed(1)}ms @ ${site()}`);
    return r;
  };
}

const origFetch = global.fetch;
global.fetch = async function (input, init) {
  const url = String(input?.url ?? input);
  const t0 = performance.now();
  log(`fetch ${url} @ ${site()}`);
  try {
    const r = await origFetch.call(this, input, init);
    log(`  fetch done ${url} ${r.status} after ${(performance.now() - t0).toFixed(1)}ms`);
    return r;
  } catch (e) {
    log(`  fetch failed ${url} ${e?.message} after ${(performance.now() - t0).toFixed(1)}ms`);
    throw e;
  }
};
const origWrite = process.stdout.write.bind(process.stdout);
let writes = 0;
process.stdout.write = function (chunk, ...rest) {
  writes++;
  if (writes <= 40) log(`stdout.write ${typeof chunk === "string" ? chunk.length : chunk?.length}B ${JSON.stringify(String(chunk).slice(0, 50))}`);
  return origWrite(chunk, ...rest);
};
process.stdin.on?.("data", () => {});
process.on("exit", () => log("exit"));
log("preload ready");
