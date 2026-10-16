# Architecture

Two-minute orientation for the repo. The canonical plan is
[`blueprint-v3.html`](blueprint-v3.html); where this file and the blueprint
disagree, the blueprint wins.

## Shape

```
Mac app (Tauri 2) ─┐
Android app (Tauri) ─┼── WebSocket (typed frames, seq'd, resumable) ── over Tailscale
CLI (tools/cli) ────┘                                                │
                                                                     ▼
                                                      apps/server  (Bun + TypeScript)
                                                      ├─ ws: server / dispatch / frame log
                                                      ├─ agent: personas + instant lane
                                                      ├─ jobs: queue runner + turn kind
                                                      │        (daemon work while idle)
                                                      ├─ models: router → Groq · Cerebras ·
                                                      │           NIM · Gemini · OpenRouter ·
                                                      │           LM Studio (free-first,
                                                      │           failover on 429/timeout)
                                                      ├─ stores: SQLite (WAL) + FTS5 —
                                                      │           threads/turns/messages,
                                                      │           usage_ledger, approvals,
                                                      │           memories, links, tasks, jobs
                                                      ├─ tools: registry (schema + timeout);
                                                      │          native tools land with P2
                                                      └─ later: ACP bridge (P3), Gmail + ICS (P4)
```

## Process lifecycle

`bun run serve` is the only server mode; `bun run daemon start` spawns that
same command detached (own session, stdio → `data/agni.log`), writes
`data/agni.pid`, and only reports success once `/health` answers. `daemon stop`
is SIGTERM (SIGKILL only if the process refuses to die), and `serve` handles
both signals by stopping the job runner, flushing the frame log, and closing
SQLite. bb-1 later runs the same command under systemd — the pid and log files
are local convenience, not a second supervisor.

## Background jobs

The `jobs` table is the queue: `queued → running → done | failed`, claims are
transactional, attempts are counted, and a job a dead process left `running`
is requeued at boot. One runner per daemon executes kinds sequentially (three
per poll by default) so background work cannot stampede a free-tier provider.

The only kind at this stage is `turn`: run one prompt in a thread. That is how
the daemon does things unprompted — reminders now, the precomputed 07:55 brief
in P2 — and how it chats back: the turn streams through the normal frames to
any connected client, and completion raises `notify`. A `turn` job with
`everyMs` reschedules itself and keeps the thread it created, so recurring work
stays one conversation. Failures retry with backoff, then park as `failed` with
a notification — never silently.

## The one contract

`packages/protocol` defines every frame, in one file, validated with zod. The
server assigns a monotonic `seq` to every outbound frame and keeps a bounded
replay log; clients that reconnect send `resync {lastSeq}` and re-enter the
stream. See [`protocol.md`](protocol.md). Frame changes go through the
protocol package first.

## Speed rules (why this stays fast)

- **S1 constant prompt** — system + persona + the last 16 messages, hard cap.
  Nothing grows with history (`agent/loop.ts`).
- **S2 memory is a tool** — FTS5 indexes (memories, links) are read by tools
  on demand, never injected into the prompt prefix. Schema is ready; tools
  arrive with P2.
- **S3 lane isolation** — instant lane is one call, no tools, no steps
  (`runInstantTurn`). Task/deep lanes get their own runner with the job queue.
- **S4 write-time work** — summaries/indexes are written when data lands, not
  read time. Cron (07:55 brief) lives in the job queue (P2).
- **S5 warm path** — router health + cooldown avoids paying timeouts twice;
  provider keep-alive prefill is a P0+ tuning item.
- **S6 perceived speed** — client-side: local echo + streaming deltas
  (frames are ready; the app consumes them in P1).
- **S7 bounded everything** — per-turn timeout, first-token timeout, step
  budgets in the lane runner, daily caps on the usage ledger.

## Failure honesty

- Failover happens only **before** the first token reaches the client. A stream
  that died mid-flight ends the turn (`MidStreamError` → `turn.end{error}`)
  instead of duplicating text from a second provider.
- Partial output is persisted even when a turn is cancelled or times out; the
  `stop_reason` column records what actually happened.
- A client that falls behind the replay log gets `resync_gap` and reloads
  state from the database, which always holds the durable message history.

## Stores

One SQLite database (WAL) at `data/agni.sqlite` (dev). Tables are created by
numbered migrations in `apps/server/src/db/migrations.ts`: `devices`,
`threads`, `turns`, `messages`, `usage_ledger`, `approvals`, `tasks`, `links`,
`memories`, `jobs`, plus standalone FTS5 indexes.

## Home

This Mac now; bb-1 later (systemd/compose + Tailscale, same image, SQLite
backup). The server binds to `AGNI_HOST` only — loopback in dev, the Tailscale
interface on bb-1. Nothing ever listens on the public internet.
