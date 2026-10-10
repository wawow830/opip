// Preload for bench/startup.py: records time-to-interactive (ms since process start) to $PI_TTI_FILE.
// In PI_STARTUP_BENCHMARK mode, main() calls setTimeout(..., 150) right after interactiveMode.init()
// finishes (first full frame rendered, input handlers bound), so that call marks TTI.
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const out = process.env.PI_TTI_FILE;
const orig = global.setTimeout;
let done = false;
global.setTimeout = function (fn, ms, ...args) {
  if (!done && ms === 150 && out && /\bmain\b/.test(new Error().stack)) {
    done = true;
    fs.writeFileSync(out, String(performance.now()));
  }
  return orig.call(this, fn, ms, ...args);
};
