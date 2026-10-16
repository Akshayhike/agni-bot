# Agni

Speed-first personal assistant. Our own harness, our own server, our own apps.
No walled gardens: free model tiers called by API, a Gmail mailbox, and clients
we control. Full plan: [`docs/blueprint-v3.html`](docs/blueprint-v3.html).

## Layout

| Path | What it is |
| --- | --- |
| `apps/server` | Bun + TypeScript core: WebSocket protocol, agent loop, model router, SQLite stores, daemon lifecycle, job queue. Runs on this Mac now, bb-1 later. |
| `apps/app` | Tauri 2 clients (macOS + Android) from one codebase. P1 — Rust toolchain not installed yet. |
| `packages/protocol` | Wire protocol v1: typed frames shared by server and both apps. This is the contract. |
| `tools/cli` | Protocol client: `chat` (interactive), `ask`, `bench`, `ping`. The P0 proof gate lives here. |
| `docs` | Blueprint v3 (canonical), architecture notes, protocol spec. |

## Quickstart

```sh
bun install
cp .env.example .env        # add at least GROQ_API_KEY and/or NVIDIA_API_KEY
bun run migrate
bun run daemon start        # run the server detached in the background
bun run pair --name Mac     # prints a device token once — save it
export AGNI_TOKEN=agni_…
bun run chat                # talk to it; /help lists commands
bun run daemon status       # pid, uptime, provider health, usage today
```

Foreground alternative while hacking: `bun run dev` (watch mode). Both modes are
the same process; the daemon just detaches it, writes `data/agni.pid`, appends
to `data/agni.log`, and waits for `/health` before reporting success.

### Background work (the daemon doing things on its own)

```sh
bun run job add "Draft my morning brief from yesterday's notes" --at 07:55 --every 1d
bun run job add "In one line: what should I not forget today?" --in 2h
bun run job list --all      # state, next run, last result
bun run job run <id>        # make a job due now
bun run job rm <id>         # cancel
```

Jobs run in the daemon's `turn` lane: the model call streams into its thread
(so any client sees it live) and completion raises a `notify` frame. Failures
retry with backoff, then land as `failed` with a notification.

### Smoke test without any keys

```sh
bun run mock &              # healthy provider on :9911
MOCK_PORT=9912 MOCK_FAIL=1 bun run mock &          # 429s — failover fixture
GROQ_API_KEY=test GROQ_BASE_URL=http://127.0.0.1:9912/v1 \
LMSTUDIO_BASE_URL=http://127.0.0.1:9911/v1 LMSTUDIO_MODEL=mock \
  bun run serve &                                   # answers via LM Studio after Groq 429s
```

With the mock running, the daemon and chat also work keyless:

```sh
GROQ_API_KEY=test GROQ_BASE_URL=http://127.0.0.1:9911/v1 bun run daemon start
AGNI_TOKEN=… bun run ask "what is 2+2"    # → mock(mock-model): what is 2+2
```

## Environment

All configuration lives in `.env` at the repo root (Bun loads it automatically;
it is gitignored). See [`.env.example`](.env.example) for the full list —
providers are enabled by the presence of their key, everything else has a
working default.

## Phases

| Phase | Scope | Proof |
| --- | --- | --- |
| P0 | Server + instant lane, CLI test client | p50 ≤ 1.5 s over the socket, streaming deltas, failover on 429 |
| P0.5 | Daemon lifecycle, chat REPL, background jobs | `daemon start`, `chat` streams, scheduled job lands in a thread + notify |
| P1 | Mac app (Tauri): pairing, threads, streaming, resync | Kill app mid-turn, reopen, turn resumes |
| P2 | Memory/links/tasks stores + 07:55 brief via ntfy | Capture → retrieve → approve from a notification |
| P3 | ACP (codex-acp) + MCP (REA) | Repo task streams from Codex into the same thread UI |
| P4 | Gmail (IMAP/SMTP app password) + calendar ICS | Approved draft sends; brief shows a real event |
| P5 | Android + bb-1 + polish | Phone over Tailscale; server survives a reboot |

P0–P2 is the "faster than Hermes and usable daily" milestone.

## Rules

- `packages/protocol` is the contract. Change frames there; bump
  `PROTOCOL_VERSION` on breaking changes and update `docs/protocol.md`.
- Free-first routing. Provider keys live server-side only — never in the repo,
  never in the apps.
- Anything that shells out, writes files outside scratch, sends mail, or pays
  money is approval-gated before it is implemented.
- No IDE features, ever. Repo-shaped work is delegated through ACP harnesses.
- `bun test` and `bun run typecheck` pass before every commit.
