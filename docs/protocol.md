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
  `agents.update`. `hello.ok` answers the connecting socket only and is not
  part of the replay log. The server closes connections that don't complete
  the handshake within `AGNI_HELLO_TIMEOUT_MS` (code 4001), on version mismatch
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
| `thread.list` | `{limit?}` | Recent threads, newest first (default 20, max 200). |
| `thread.history` | `{threadID, limit?}` | Durable messages, last N chronological (default 50, max 500). |
| `job.list` | `{limit?}` | Tasks and routines, newest/next due first. |
| `job.set` | `{jobID, action}` | `action`: `pause \| resume \| run`. |
| `job.delete` | `{jobID}` | Deletes a task unless it is running; replies with a refreshed `job.list.ok`. |
| `provider.add` | `{providerID, apiKey, model?}` | Adds a supported API provider over the authenticated socket. The daemon stores the key and optional model ID in its mode-600 `.env` and updates the live router; the key is never returned. |
| `provider.model.set` | `{providerID, model}` | Changes a configured provider's model ID on the daemon and updates the live router. |

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
| `thread.list.ok` | `{threads: [{id, agentID, title?, updatedAt}]}` | Answer to `thread.list`; addressed to the requester. |
| `thread.history.ok` | `{threadID, title?, messages: [{id, role, text, createdAt, turnID?}]}` | Answer to `thread.history`; addressed to the requester. |
| `job.list.ok` | `{jobs: [...]}` | Answer to `job.list`, `job.set`, or `job.delete`; addressed to the requester. |
| `provider.add.ok` | `{providers: [...]}` | Provider metadata after adding a key; contains no credentials. |
| `presence` | `{state}` | `online \| offline`. |
| `error` | `{code, message, retryAfter?}` | See codes below. |

## Error codes (v1)

`bad_frame`, `unauthorized`, `version_mismatch`, `unknown_thread`,
`unknown_agent`, `unknown_request`, `unknown_job`, `job_running`, `no_provider`, `provider_failed`,
`unknown_provider`, `invalid_key`, `provider_exists`, `provider_storage`,
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

`hello.ok` and the `thread.list.ok` / `thread.history.ok` answers are for one
connection, not the shared stream: they consume a `seq` like every frame but
are skipped on replay. A client never "missed" a reply addressed to someone
else. Everything else — turns, tokens, tool strips, approvals, notifications —
is replayable.
