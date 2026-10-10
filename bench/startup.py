#!/usr/bin/env python3
"""Measure pi interactive startup time inside a pseudo-terminal that answers
terminal queries like a real terminal (kitty) would.

Usage: bench/startup.py [runs] [--quiet] [--no-reply] [-- extra pi args]
Env:   PI_BIN="node --cpu-prof ... /path/cli.js"   (default: pi)
Uses PI_STARTUP_BENCHMARK=1 (pi exits right after first full render) and PI_TIMING=1.
"""
import os, pty, sys, time, select, re, statistics

args = sys.argv[1:]
extra = args[args.index("--") + 1:] if "--" in args else []
args = args[: args.index("--")] if "--" in args else args
runs = next((int(a) for a in args if a.isdigit()), 5)
quiet = "--quiet" in args
reply = "--no-reply" not in args
cmd = os.environ.get("PI_BIN", "pi").split() + extra
tti_file = f"/tmp/pi-tti-{os.getpid()}"
preload = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tti-preload.cjs")
env = dict(os.environ, PI_STARTUP_BENCHMARK="1", PI_TIMING="1", PI_TTI_FILE=tti_file,
           NODE_OPTIONS=(os.environ.get("NODE_OPTIONS", "") + f" --require {preload}").strip())
ansi = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[\]P_][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?")

PALETTE = ["000000", "cc0403", "19cb00", "cecb00", "0d73cc", "cb1ed1", "0dcdcd", "dddddd",
           "767676", "f2201f", "23fd00", "fffd00", "1a8fff", "fd28ff", "14ffff", "ffffff"]

def rgb(h):
    return "rgb:" + "/".join(h[i:i + 2] * 2 for i in (0, 2, 4))

def answer(buf):
    """Return terminal replies for queries found in buf."""
    out = b""
    for m in re.finditer(rb"\x1b\](10|11|4;(\d+));\?(?:\x07|\x1b\\)|\x1b\[c|\x1b\[\?u", buf):
        s = m.group(0)
        if s == b"\x1b[c":
            out += b"\x1b[?62;22;52c"
        elif s == b"\x1b[?u":
            out += b"\x1b[?0u"
        elif m.group(1) == b"10":
            out += f"\x1b]10;{rgb('dddddd')}\x1b\\".encode()
        elif m.group(1) == b"11":
            out += f"\x1b]11;{rgb('000000')}\x1b\\".encode()
        else:
            i = int(m.group(2))
            out += f"\x1b]4;{i};{rgb(PALETTE[i % 16])}\x1b\\".encode()
    return out

times, ttis, last = [], [], b""
for i in range(runs):
    if os.path.exists(tti_file):
        os.remove(tti_file)
    t0 = time.perf_counter()
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(cmd[0], cmd, env)
    import fcntl, termios, struct
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    out = b""
    while True:
        r, _, _ = select.select([fd], [], [], 30)
        if not r:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        if reply:
            rep = answer(chunk)
            if rep:
                os.write(fd, rep)
    os.waitpid(pid, 0)
    times.append((time.perf_counter() - t0) * 1000)
    if os.path.exists(tti_file):
        ttis.append(float(open(tti_file).read()))
        os.remove(tti_file)
    last = out

if not quiet:
    clean = ansi.sub(b"", last).decode(errors="replace")
    for line in clean.splitlines():
        if re.search(r"^\S.*:\s*\d+ms$|Timings", line.strip()):
            print(line.strip())
if ttis:
    print(f"time-to-interactive: median={statistics.median(ttis):.0f}ms min={min(ttis):.0f}ms max={max(ttis):.0f}ms")
print(f"wall (incl. 150ms benchmark hold + exit): median={statistics.median(times):.0f}ms min={min(times):.0f}ms max={max(times):.0f}ms (runs={runs})")
