# Agni Web

React + TypeScript port of the SwiftUI Mac client in `apps/mac`. The views,
intents, connection behavior, and design tokens follow the native app; this is
a port, not a redesign.

## Run

From the repository root:

```sh
pnpm install
bun run daemon start
bun run pair --name Web     # copy the one-time token
pnpm web                    # Vite on http://127.0.0.1:5173
```

Enter the daemon address (for example `127.0.0.1:8787` or its Tailscale
address) and the token. The browser stores the device token in `localStorage`
(`"browser"` secret kind, with an in-memory fallback). **Forget this device**
removes it.

The pairing form checks `GET /health` before opening the socket, so a daemon on
a different origin must send CORS headers; the server's `/health` does.

## Where things are

| Path | What it is |
| --- | --- |
| `src/state/app-model.ts` | `AppModel` port: pairing, connect/reconnect, frames, intents, health polling, toasts, window chrome. |
| `src/state/use-app-model.tsx` | React context plus `useSyncExternalStore`. |
| `src/components/` | `RootView`, pairing, sidebar, thread, composer, inspector, settings, providers, agents. |
| `src/styles/` | Swift design tokens and the app stylesheet. |
| `test/` | Vitest + Testing Library UI smoke tests. |
| `scripts/ui-smoke.mjs` | Playwright E2E against a real daemon. |

The shared client core lives in `packages/client` (`@agni/client`) and mirrors
`AgniKit`: frame codec, settings, health, transport, connection loop, and the
conversation reducer. `packages/protocol` remains the wire contract.

## Test

```sh
pnpm check                                  # all typechecks + client/web + server tests
pnpm --filter @agni/web test                # UI smoke tests
pnpm --filter @agni/web smoke:ui            # browser E2E (see below)
```

`smoke:ui` needs a running daemon, a running Vite dev server, and a one-time
token:

```sh
AGNI_URL=127.0.0.1:8788 AGNI_TOKEN=agni_… pnpm --filter @agni/web smoke:ui
```

It pairs a fresh browser profile, completes first-run onboarding, sends a
message, waits for the streamed mock reply, then exercises the agent switcher,
settings, and connection popover. Screenshots land in `artifacts/web-e2e/`
(gitignored).
