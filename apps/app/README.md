# apps/app — Mac + Android clients (P1)

One Tauri 2 codebase, two targets: a clean black macOS app and an Android app,
talking WebSockets to the server over Tailscale. Nothing here yet on purpose —
P0 is the server + instant lane; this scaffold lands with P1.

## What goes here

- `src/` — the web UI (TypeScript, consuming `@agni/protocol` for frames)
- `src-tauri/` — the Rust shell and Tauri config (desktop + Android targets)

## Before scaffolding (not installed on this Mac yet)

- Rust toolchain: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Tauri CLI: `bun add -d @tauri-apps/cli` (or `bunx tauri`)

## Scaffold command (run at P1)

```sh
cd apps/app
bunx create-tauri-app@latest . --template vanilla-ts --manager bun --identifier dev.agni.app
```

Then wire it to the protocol:

- Connect: `ws://<tailscale-host>:8787/ws` → `hello {token, device}` (token from
  `bun run pair` — QR pairing comes with P1)
- Frames: import from `@agni/protocol`; never hand-roll frame shapes.
- On reconnect: `resync {lastSeq}` and replay; mid-turn streams must resume.

## Design constraints (Blueprint v3 §7)

- True black by default; thumb-reachable primary actions on Android;
  keyboard-first on Mac (⌘K switch agent, ⌘N new thread).
- Local echo on send (<30 ms UI ack), token streaming into the bubble, tool
  activity strips, approval buttons with previews.
- Kill and reopen mid-turn → the turn resumes (P1 proof).
