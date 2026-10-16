# Agni for Mac — design plan

The app is where Agni is met: a chat client for a personal assistant that runs
on your own machine, over a private mesh. The shipped mark is a flame (`#FF3146`)
on charcoal — Agni is fire, and the assistant's whole promise is that it is *at
home*: on your box, one keystroke away, never in someone else's cloud.

## Concept

A familiar Mac conversation window: searchable agents and tasks on the left,
with one active chat in the center. Selecting an agent opens its latest chat;
the sidebar does not expose a thread history list. The title bar is transparent
and the full-height content shares one top row with the native traffic lights.
The flame sits in a warm circular badge; the rest of the interface uses quiet
neutral surfaces so the conversation is easy to scan.

## Tokens

Color (4–6 core values, everything else derives):

| Token | Value | Use |
| --- | --- | --- |
| `canvas` | `#1C1C1C` | main conversation background and header |
| `sidebar` | `#141414` | searchable conversation list |
| `surface` | `#232326` | search field and composer |
| `incomingBubble` | `#2A2A2D` | assistant message surface |
| `outgoingBubble` | `#E8E8E3` | user message surface |
| `hairline` | `rgba(255,255,255,0.07)` | pane and header separators |
| `ink` | `#F3F3F3` | prose |
| `inkSecondary` | `#8A8A8E` | previews, metadata |
| `ember` | `#FF3146` | identity + live activity (streaming, focus, badge) |
| `emberDeep` | `#C4293C` | pressed states, gradient tail of the flame |

Semantic status uses Apple's dark-mode system colors, never brand color:
`.green` approved, `.red` reject/stop, `.orange` attention, `.secondary` idle.
`amber #F0B95A` is the persona color the server already assigns to Agni; the
app keeps it as the *secondary* warmth (scheduled work, routines).

Type — one family (SF Pro via the system font), SF Mono for machine values.
No third face.

| Role | Size/weight | Notes |
| --- | --- | --- |
| Empty-state headline | 22 semibold | one per screen, sentence case |
| Chat body | 15 regular | line spacing 4, measure capped at 72ch |
| Row title | 13 medium | thread + agent names |
| Preview/meta | 12 regular | one line, truncated, no ellipsis games |
| Machine values | 11 monospaced | model ids, tokens, latency, ids |

Layout — the native three-pane idiom, not a custom chrome:

```
┌───────────────┬───────────────────────────────┬──────────────┐
│ Agni      ●   │  Thread title        ⌘N ⌘K ⇧⌘I │  Agent       │
│ flame roster  │                               │  avatar      │
│               │  ── today ──                  │  model, lane │
│ Threads       │                               │              │
│ ┌───────────┐ │  you            ▓▓▓▓▓▓▓▓▓▓▓   │  Routines    │
│ │ titlе     │ │  Agni  ░░░░░░░░░░░░░░░░░░░░   │  toggle      │
│ │ preview   │ │  Agni  ░░░░░░░░░░░░░░░░░░░░   │  toggle      │
│ └───────────┘ │                               │              │
│               │  ┌─────────────────────────┐  │  Connections │
│               │  │ + Message Agni    ▸     │  │  provider ok │
│               │  └─────────────────────────┘  │              │
│               │  daemon ok · groq · 82ms      │  Today       │
└───────────────┴───────────────────────────────┴──────────────┘
```

Left-aligned prose in the chat column, centered only for day separators and
system notes. The composer is a full-width pill anchored to the bottom of the
chat pane. Connection details live in the header's system-status popover rather
than a persistent technical footer.

## Principles

1. **Black is the room, the flame is the light.** Ember only marks live agent
   presence. If everything glows, nothing does.
2. **Every state is legible without color.** Connection state, cut-short turns,
   cooling providers and failures all say what happened in words.
3. **The message is the interface.** No nested navigation, no settings maze:
   ⌘K agents, ⌘N new thread, ⌘F find, ⇧⌘I inspector, ⏎ send, ⌘. stop.
4. **Apple-first.** A unified compact title bar, full-height two-pane layout,
   native popovers, full keyboard access, VoiceOver labels, Reduce Motion and
   Increase Contrast respected.
5. **Honest surfaces.** A cancelled turn says "Stopped". A timeout says
   "Timed out after 30s". A provider is "cooling 12s — 429". Empty lists
   invite the next action instead of showing a mood.

## Deliberately not doing

- No card grid, no dashboards, no boxes inside boxes.
- No all-caps eyebrows, no middle-dot metadata strings, no gradient washes.
- No second palette for "AI" color; the flame is the only warm thing.
- No fake metrics: costs show tokens and latency the server actually reports,
  and "free tier" is stated, not estimated.
