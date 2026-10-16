# Wire protocol v1

The contract between the server and every client (Mac app, Android app, CLI).
Machine version: [`packages/protocol/src/frames.ts`](../packages/protocol/src/frames.ts) —
if the two disagree, the code wins, then fix this doc.

## Envelope

- One WebSocket per client: `GET /ws` (HTTP upgrade). No auth on upgrade; the
  first frame must be `hello`.
- Frames are JSON text. Client frames carry no sequence number. **Every**
  server frame carries `seq`: a positive, monotonically increasing integer
  assigned by the server.
- A client that misses frames reconnects and sends `resync {lastSeq}`; the
  server replays every frame after `lastSeq`. If the gap is older than the
  bounded replay log, the client gets `error {code: "resync_gap"}` and reloads
  state from the server's durable storage.
- Handshake: connect → `hello {v, token, device}` → `hello.ok` +
  `agents.update`. The server closes connections that don't complete the
  handshake within `AGNI_HELLO_TIMEOUT_MS` (code 4001), on version mismatch
  (4002), or on a bad token (4003).
- `lastSeq` in `hello.ok` is the server's current sequence; a client whose own
  `lastSeq` is higher (server crash + restart) must treat the difference as a
  gap and reload.

## client → server

| Frame | Payload | Notes |
| --- | --- | --- |
| `hello` | `{v, token, device}` | First frame. `v` is the protocol version. |
| `resync` | `{lastSeq}` | Replay everything after `lastSeq`. |
| `msg.send` | `{threadID, text, files?}` | `threadID: ""` creates a new thread; the assigned id arrives in `turn.start`. |
| `msg.cancel` | `{turnID}` | Interrupts the turn: providers abort, partial output is kept. |
| `approve.reply` | `{requestID, decision}` | `decision`: `once \| always \| reject`. |
| `agent.select` | `{agentID}` | Sets the persona for subsequent `msg.send` on this connection. |
| `thread.open` | `{threadID}` | Pins the session's active thread. Silent; history comes via `resync`. |

## server → client

| Frame | Payload | Notes |
| --- | --- | --- |
| `hello.ok` | `{v, serverTime, lastSeq}` | `lastSeq` = seq of this frame. |
| `token` | `{turnID, threadID, delta}` | One streaming chunk. |
| `turn.start` | `{turnID, threadID, agentID}` | Turn accepted; called before any `token`. |
| `turn.end` | `{turnID, threadID, stopReason, usage?}` | `stopReason`: `end \| cancelled \| error \| timeout \| budget`; `usage`: `{provider, model, inputTokens?, outputTokens?, latencyMs?}` (latencyMs is server-measured model call time). |
| `tool.start` | `{callID, name, preview?}` | Tool activity strip. |
| `tool.update` | `{callID, preview?}` | |
| `tool.end` | `{callID, ok, preview?}` | |
| `approval.request` | `{requestID, action, preview, buttons}` | `buttons`: subset of `once \| always \| reject`. |
| `form.request` | `{requestID, question, options?}` | Ad-hoc question to the user. |
| `notify` | `{title, body, sound?}` | Push-worthy event (ntfy mirrors this on Android). |
| `agents.update` | `{agents: [{id, name, color?, model?, tools?}]}` | Roster snapshot. |
| `presence` | `{state}` | `online \| offline`. |
| `error` | `{code, message, retryAfter?}` | See codes below. |

## Error codes (v1)

`bad_frame`, `unauthorized`, `version_mismatch`, `unknown_thread`,
`unknown_agent`, `unknown_request`, `no_provider`, `provider_failed`,
`resync_gap`, `internal`.

## Versioning

`PROTOCOL_VERSION` bumps on any breaking change (removed/renamed frame or
field, changed semantics). Additive optional fields do not bump the version;
clients must ignore unknown fields. The server rejects `hello` with an
unsupported `v` instead of guessing.

## Replay log (v1 bounds)

The server keeps the last `AGNI_FRAME_LOG_CAPACITY` outbound frames (default
1000) for `resync`. Deltas are frames too, so a client offline through a long
turn will likely reload rather than replay — by design: messages are durable
in SQLite, replay is a latency optimization, not a storage layer.
