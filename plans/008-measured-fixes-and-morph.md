# 008 — Measure the lag, fix its causes, redo the splitter, ticket slide and route transitions as a morph

- **Status**: DONE
- **Commit**: see `git log` (stream H)
- **Severity**: HIGH
- **Category**: Performance, Physicality & origin, Cohesion
- **Estimated scope**: base.css, workspace.css, Splitter/split, Workspace.tsx, TicketPanel, viewTransition.ts, motion e2e

## What the measurements showed (Chromium, per-frame rAF deltas, CPU throttle 1x and 4x, 600 rows + ticket image)

- With View Transitions off, route changes were almost clean (0-9 % slow frames); with them on, 10-48 %
  (p95 33-66 ms at 4x, long tasks 50-70 ms). The cost was the transition layers themselves.
- `filter: blur()` in the sibling transition: removing it took sibling navigation from 10-16 % to 0-2 % slow frames.
- Removing the hero clip/radius and the sheet shadow made no difference (not the cause).
- Full-page layers (`page` and `topbar` groups) were extra full-viewport textures on every route change.
- The splitter restore transition hit p95 66 ms (4x) with two 70 ms long tasks; every pointer move of a drag
  re-rendered the whole Workspace through `setSplit`.

## What changed

1. Route transitions are a morph: one cross-fading root layer (old stays opaque, new fades in 60 ms later over
   180 ms, `mix-blend-mode: normal`) plus named shared elements that travel: `hero` (card <-> workspace),
   `proj-title`, `ticket` (workspace picture <-> settings preview), `heading` (siblings). No blur, no `page` or
   `topbar` groups. Shared elements move 300 ms on `--ease-drawer`. Names exist only for the running transition.
   The transition callback is released one frame after the route commits so the top-bar crumbs (set by page
   effects) exist when the new frame is captured, otherwise `proj-title` has no partner.
2. Splitter: the drag writes `--ws-tracks` on the grid once per frame, so React does not render per move; the
   handle follows the pointer 1:1 (grab offset kept), a hidden panel is revealed while it is dragged out, the panel
   that would hide dims (`data-hide`), and on release the grid eases (220 ms) to the settled size or hides.
   Bigger grab area and a dotted handle.
3. Ticket slide: flat, 180 ms, 32 px, ease-out, no rotation/scale/perspective; skipped on a held key.

## Verification

Before/after numbers and frames are in the stream H report. `e2e/specs/motion.spec.ts` covers the slide, the held
key, the 1:1 splitter, the dimming and the reveal; its `frames` test (E2E_FRAMES=1) records mid-transition frames.
