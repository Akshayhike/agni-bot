# The web UI, built for a phone

The web app was a desktop app that happened to fit in a browser window. It is
now a phone app that grows into a desktop one. This is the reasoning behind
the current shape, and the rules to keep when changing it.

## The reference

The design language comes from **Grok Bot (iOS, Aug 2026)** — 117 screenshots
of a phone app whose whole premise is the same as Agni's: a roster of always-on
agents you talk to in one continuous thread each. What we took from it:

| Reference trait | What we did |
| --- | --- |
| Near-black night mode, surfaces a shade apart | Refreshed the token ramp to a true near-black (`--canvas: #0d0d0f`) with `--surface`, `--surface-raised`, `--incoming-bubble` as the only lit layers. Ember stays the only warm colour — Agni's identity. |
| Floating capsule composer: `+` · field · mic/arrow | Kept the capsule, moved it to the bottom of the thumb zone, made the mic a quiet ghost icon instead of a filled button, and the send arrow a solid circle. |
| Rounded everything: 16–24px radii | Bubbles 20px, composer 26px, cards 14–16px, icon buttons circular. |
| Roster as a searchable list with avatars and status dots | The sidebar became a slide-in drawer on phones: search pill, 36px avatars, state dot, unread dot. |
| Header: back · agent · one action | Header is now a 56px bar: menu button, agent identity, round share and monitor buttons. |
| Quick replies as a bordered list of labelled choices | `say`-backed forms render as a single card of `A`/`B`/`C` rows with hairline separators, not a row of anonymous buttons. |
| Grouped inset settings rows, sheets from the bottom | Settings is a full-screen page on a phone: title, back, a scrollable row of pill tabs. Dialogs are bottom sheets. |
| Tiny centred day stamps | Day dividers stay centred and small; nothing else centres but the thread's own seams. |

We did **not** take the blue accent. Ember is Agni's.

## The rules

1. **One bubble per answer.** The narration a model writes between tool calls
   never reaches the client; a channel turn buffers the answer and emits it as
   a single `token` frame. See `docs/protocol.md`.
2. **Bubbles hug their text.** Assistant bubbles shrink to their content;
   the user bubble caps at 86% of the column on a phone.
3. **The column fills the space.** The transcript and the composer use the
   full width of the chat column, with a `clamp()` gutter. There is no narrow
   measure in the middle of a wide screen.
4. **Nothing smaller than 44px under a thumb.** Touch targets, 16px inputs (so
   iOS does not zoom on focus), safe-area padding top and bottom.
5. **The phone layout is the base layout.** Under 720px there is one column, a
   drawer instead of a sidebar, a sheet instead of a third column, and sheets
   instead of centred dialogs.

## Where the code lives

- `apps/web/src/styles/tokens.css` — colour, type, radius, motion, phone
  tokens (`--touch-target`, `--composer-radius`, `--safe-top`).
- `apps/web/src/styles/app.css` — layout, and the phone block at the end of
  the file.
- `apps/web/src/state/app-model.ts` — `isSidebarPresented` and the drawer
  open/close.
- `apps/web/src/components/SidebarView.tsx` — the roster, which is a drawer on
  a phone and a column on a desktop.
