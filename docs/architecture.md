# Architecture

Two-minute orientation for the repo. The canonical plan is
[`blueprint-v3.html`](blueprint-v3.html); where this file and the blueprint
disagree, the blueprint wins.

## Shape

```
Web app (React) ─────┐
Mac app (SwiftUI) ───┤
Android app (Tauri) ─┼── WebSocket (typed frames, seq'd, resumable) ── over Tailscale
CLI (tools/cli) ─────┘                                                │
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
                                                      │          deterministic P2 capture + retrieval
                                                      └─ later: ACP bridge (P3), Gmail + ICS (P4)
```

### Clients

`apps/mac` and `apps/web` are the same product in two shells: pairing,
reconnect/resync, streaming transcript, approvals and forms, agent switcher,
providers/plugins settings, and the details inspector. `apps/web` is the
reference port for further platforms; `packages/client` holds its
transport-agnostic core (frame codec, settings, health, connection loop,
conversation reducer). Both speak `packages/protocol` v2, so a frame change
lands there first and then flows outward.

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

Background results land inside the agent's conversation as a `background`
session block — born closed, they join the transcript without stealing the
active chat block — so a reminder or the morning brief reads like the agent
texted you where you already talk.

Live and background turns share a process-wide model stream limit
(`AGNI_MAX_CONCURRENT_TURNS`, default 4). This keeps provider usage and local
memory bounded; chat turns that arrive at capacity receive a `server_busy`
error and can be retried. `/health` reports active and configured capacity.
The queue and WebSocket replay state are process-local, and SQLite is the
single-writer store, so this deployment scales vertically within one daemon;
horizontal replicas require shared coordination and a multi-writer database.

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
  on demand, never injected into the prompt prefix. The task persona exposes
  bounded memory, link, and task store tools.
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

## Task lane

The `agni-task` persona uses `agent/task-loop.ts`; `agni` continues through
the one-call instant runner. Each task step sends the same system prompt and
tool schemas first, then the compacted session and recent messages. That keeps
the leading request prefix stable for provider-side prefix caching when the
provider supports it. The loop has a 16-tool-call and 16k-token budget,
persists its message log and each tool result, and only registers the P2 store
tools. An interrupted session restores saved tool results; calls with an
uncertain outcome are returned as errors and never replayed automatically.
Approval decisions are stored in SQLite and resolve the active loop through
the approval broker.

Two bounds keep a turn from wandering instead of working. A turn that only
*looks* at the app's own source — reading the checkout to find out how to
build a feature it has no tool for — is told to act, and then stopped with
the truth: what it can do, and that it cannot ship changes to the app. A turn
that runs out of budget still answers, naming the work that happened instead
of reporting a limit.

Scheduling is a tool, not a cron entry: `job_schedule` puts a prompt on the
job queue with a wall-clock schedule (`dailyAt` + `days`, so "weekdays at
9:05" skips the weekend), `job_list` shows what is queued, and `job_cancel`
stops it. The daemon's `turn` job kind runs the scheduled prompt in the task
lane and raises the next occurrence itself.

Redefining an agent is a tool too: `update_agent` writes the owner's words
into the agent's role and prompt (durable, and broadcast so the app shows
the new role), and `create_agent` gives a new agent its own allowlist and
role — both survive a restart, because the roster is rebuilt from the
`agents` rows at boot.

A handoff lands where it belongs: the delegated work is a block in the
*asked* agent's conversation, so opening that agent in the app shows the
work instead of an empty room, and the chat reads "Messaged F.R.I.D.A.Y."
rather than a routing dump.

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
`conversations`, `threads`, `turns`, `messages`, `usage_ledger`, `approvals`,
`tasks`, `links`, `memories`, `jobs`, plus standalone FTS5 indexes.

A conversation is the one user-facing chat with an agent (blueprint §5): one
per agent, never reset. Every `threads` row is a session block inside it — an
invisible context span that opens with the conversation's carried summary and
closes into it (`closed_by`: `manual` for /new, `context` at pressure,
`background` for routine results). Compaction is write-time (S4): one bounded
model call per closing block (`agent/rollover.ts`); a failed summary carries
the previous summary forward and never blocks a turn.

## Home

This Mac now; bb-1 later (systemd/compose + Tailscale, same image, SQLite
backup). The server binds to `AGNI_HOST` only — loopback in dev, the Tailscale
interface on bb-1. Nothing ever listens on the public internet.

P2 store writes keep memory/link FTS rows in the same SQLite transaction as
their base records. Chat capture recognizes `remember:`, `add task:`, and
pasted HTTP(S) URLs; explicit `search memory:`, `search links:`, and `list
tasks` requests use bounded store queries without changing the instant prompt.
The daemon also schedules a date-keyed 07:55 local morning brief in the durable
job queue and exposes authenticated task list/update frames to the Mac task
card.
