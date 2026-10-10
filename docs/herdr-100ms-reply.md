# herdr: socket API replies ~100 ms late when request bytes arrive after accept()

herdr 0.9.3 (aarch64 Linux). Draft upstream report.

Any request on `$HERDR_SOCKET_PATH` gets its reply after ~100 ms unless the request bytes are already
in the socket buffer when the server accepts the connection. Looks like the connection handler reads
non-blockingly and, on `WouldBlock`, sleeps/polls on a 100 ms tick instead of waiting for readiness.

## Repro

```python
import socket, time, os, json
req = (json.dumps({"id": "p", "method": "ping", "params": {}}) + "\n").encode()
for delay in [0, 0.001, 0.005]:
    s = socket.socket(socket.AF_UNIX); t = time.time()
    s.connect(os.environ["HERDR_SOCKET_PATH"]); time.sleep(delay); s.sendall(req); s.recv(4096)
    print(f"send {delay*1000:.0f}ms after connect -> reply after {(time.time()-t)*1000:.1f}ms")
```

```
send 0ms after connect -> reply after 0.1ms
send 1ms after connect -> reply after 100.2ms
send 5ms after connect -> reply after 100.1ms
```

From Node (how the pi integration connects: `net.createConnection` then write on `connect`),
it's a race: 8 consecutive pings → `100.9 100.2 0.2 100.3 0.2 100.3 100.2 0.1` ms.

## Impact

- The pi integration awaits `pane.report_agent_session` in `session_start`, which pi awaits before its
  first interactive frame → +100 ms on most pi startups.
- Every agent state report (`working`/`idle`) lands ~100 ms late.
- Likely affects other integrations and CLI calls the same way.

Suggested fixes: block on readiness (or `poll`/epoll with no 100 ms tick) in the connection reader; and in
the pi integration, don't `await` the report in `session_start`.
