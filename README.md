# .pi — making `pi` fast

Measured and reduced interactive startup of `pi` 1.1.0 (Node 24.18, herdr 0.9.3 in kitty, aarch64).

## Result

| | time-to-interactive (median, 15 runs) |
|---|---|
| before | **396 ms** |
| after  | **260 ms** (−34%) |

Time-to-interactive = process start → `interactiveMode.init()` done (first full frame, input bound),
measured in a pty that answers terminal queries like kitty (`bench/startup.py`).

## What was slow and what changed

1. **herdr integration blocked startup ~100 ms** (`~/.pi/agent/extensions/herdr-agent-state.ts`).
   Its `session_start` handler `await`s a herdr socket request, and Pi waits for `session_start`
   handlers before the first interactive frame. herdr 0.9.3 answers any request whose bytes arrive
   *after* `accept()` on a ~100 ms poll tick (see `docs/herdr-100ms-reply.md`), so every start stalled.
   Fix: report asynchronously, keeping order (session report → state).
   The file is managed by herdr and gets overwritten on reinstall/update — re-apply with:
   `node patches/herdr-nonblocking-session-start.mjs` (idempotent).

2. **pi-cliproxy rescanned every model catalog for every CPA model** (~14 ms × 2 per start).
   Replaced the linear scans with a lookup table built once; output byte-identical.
   Committed in `~/Projects/pi-cliproxy` (`9d725d4`).

## Where the remaining ~260 ms goes

| phase | ~ms | notes |
|---|---|---|
| Node bootstrap | 30 | |
| ESM compile/link of bundle | 40 | V8 compile cache already on (saves ~50 ms) |
| TUI chunk eval (marked regexes etc.) | 40 | |
| bundled **undici** eval | 30–35 | eager, only to install a global dispatcher — could be lazy (upstream) |
| typebox schema compile | 15 | |
| runtime: settings/auth/models/extensions/skills | 60 | jiti init ~10 ms for first `.ts` extension |
| `interactiveMode.init` | 25 | |

Right after TTI, `loadAllHighlightLanguages()` spends ~40 ms of main-thread time (highlight.js),
which can delay the first keystrokes. Both undici and highlight.js laziness are pi-side changes;
they need patches to pi's minified bundle (lost on `pi update`) or upstream fixes.

Tried, no gain: `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, larger V8 semi-space.

Not startup, but worth knowing: some session files are huge (205 MB, 192 MB, …; 3.1 GB total),
which makes resuming those specific sessions slow.

## Bench tools

```sh
bench/startup.py 15 --quiet                         # TTI + wall, kitty-like pty
PI_BIN="node --cpu-prof --cpu-prof-dir=/tmp/p --cpu-prof-interval 100 $(readlink -f $(which pi))" bench/startup.py 1
node bench/buckets.mjs /tmp/p/*.cpuprofile 10       # what ran in each 10 ms slice
node bench/timeline.mjs /tmp/p/*.cpuprofile         # idle gaps + stack before/after
node bench/analyze-prof.mjs /tmp/p/*.cpuprofile     # self/inclusive time
PI_BIN="node --require $PWD/bench/trace-preload.cjs $(readlink -f $(which pi))" bench/startup.py 1  # timers/sockets/spawns → /tmp/pi-trace.log
node bench/grep-bundle.mjs <chunk.js> <regex>       # search minified bundle
```

Set `HERDR_PANE_ID` to a nonexistent pane (e.g. `w6J:p999`) when benchmarking so runs don't
report agent state for your real pane.
