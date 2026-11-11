# 010 — Ticket turn as one strip (flick a card away), same code for swipe, arrows and keys

- **Status**: DONE
- **Commit**: see `git log` (stream J)
- **Severity**: MEDIUM
- **Category**: Physicality, Cohesion, Interruptibility
- **Estimated scope**: `features/workspace/TicketPanel.tsx`, `ticketStrip.ts`, `swipe.ts`, `workspace-mobile.css`, e2e

## Why

The old turn (plan 004/008) moved the outgoing canvas 32 px and cross-faded: it read as a dissolve, not as
turning a card, and a swipe had nothing to hand over to.

## What it is

- The picture on screen and its neighbour (towards the direction of travel) sit on one strip, one stage width
  apart. Only `transform` is animated; the stage clips the strip to its rounded frame.
- **Swipe** (touch, zoom 1): the strip follows the finger 1:1 (the neighbour is drawn at the start of the drag;
  where there is none the strip resists, 0.3x). Release past 25% of the width or at a flick (>= 0.4 px/ms in the
  drag direction) slides the rest out with the release speed (`slideDuration`: a fast flick shortens the slide,
  never longer than 290 ms); otherwise both spring back (EASE.out). A pointer-down during a slide catches the
  picture where it is (no jump).
- **Arrows / keys**: the next ticket is drawn into a free canvas first, then the same slide runs, 200-290 ms
  (290 ms for a full width) with `EASE.out`. Held keys (repeat) swap with no slide (plan 004). A new step during a
  slide continues from the current position; the leaving canvas keeps going, a third canvas receives the new one.
- Reduced motion: no travel, the short opacity swap of the stylesheet.
- Three canvases (`POOL`): on screen, arriving, still leaving. Inline styles are cleared in the task that cancels
  the animation (no flash); only the front canvas is visible at rest.

## Verification

Unit: `ticketStrip.test.ts` (timing, neighbour offset, legs), `swipe.test.ts`. E2E: `motion.spec.ts` (strip, repeat,
reduced motion), `workspace-phone-gestures.spec.ts` (held half way, release, retarget, nothing left behind).
Paused frames (`E2E_FRAMES=1 ... motion.spec -g frames`) were viewed in Chromium, Firefox and WebKit.
