# Agni Mac app thoughts

## Current server connection

This records the implementation as it exists so a simpler pairing flow can be
designed without losing the important constraints.

1. The app asks for a server address and a device token. A bare host becomes
   `ws://<host>:8787/ws`; `http(s)` addresses are converted to `ws(s)`, and
   `/health` is derived from the same host.
2. The token is minted on the server with `bun run pair --name "This Mac"`.
   The command prints it once. The app stores it in macOS Keychain, with a
   mode-600 Application Support file fallback if Keychain is unavailable.
3. The app checks `GET /health`, then opens one WebSocket and sends
   `hello {v, token, device}`. The server validates the device token.
4. On success, the app sends `resync {lastSeq}`. It persists the greatest
   server sequence it has seen, then reloads the thread list and open thread
   history so a missed replay does not lose durable messages.
5. Local development uses `127.0.0.1:8787`. A server on another machine must
   be reachable on the private network (normally Tailscale); the app does not
   start or install the daemon for the user.

The current approach is secure and explicit, but it makes a new user copy a
terminal command and secret by hand. The app cannot discover a remote daemon,
create a pairing token itself, or repair a revoked token. The address also
needs an explanation because `127.0.0.1` only means this Mac.

## Connection setup direction

- Say where the daemon must be running before asking for details.
- Keep the local default obvious and explain when a Tailscale address is
  needed.
- Put the one-time token command beside the token field and make it copyable.
- Check `/health` before leaving setup so a wrong address gives an actionable
  error instead of a chat window that is silently retrying.
- Keep the device token in Keychain and retain `hello` authentication plus
  sequence replay; the UI change should not weaken the protocol.
- A future pairing code or QR flow could remove manual token copying, but it
  needs a server-side short-lived pairing endpoint and a clear authorization
  step. The client cannot safely invent that flow on its own.

## Chat interface direction

The supplied references point to a familiar macOS conversation layout:
compact searchable conversations on the left, one readable transcript in the
center, an unobtrusive title bar, and a persistent rounded composer. Incoming
and outgoing messages should both read as messages, with distinct calm
surfaces. The inspector stays optional so it does not steal width from chat.

Keep Agni's dark identity and ember accent, but reserve the accent for the
assistant mark, active state, and send action. Use the user's examples as the
visual source; do not copy unrelated Messages content. Live inspection of the
system Messages app would expose personal conversations, so the app UI is
informed by the provided screenshots and macOS conventions instead.
