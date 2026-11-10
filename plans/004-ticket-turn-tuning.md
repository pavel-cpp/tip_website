# 004 — Page-turn of the ticket: faster, ease-out, skipped on key repeat

- **Status**: DONE
- **Commit**: c8d7b7a
- **Severity**: MEDIUM
- **Category**: Purpose & frequency, Easing & duration
- **Estimated scope**: 2 files + a test

## Problem

The user asked for a page-turn when stepping tickets with the arrow keys in picture-only mode, so the motion
itself stays. But it is driven from the keyboard (repeated many times in a row), its total length is
70 ms delay + 340 ms = 410 ms, the outgoing ticket uses an ease-in curve, and holding the key stacks work.

```ts
// frontend/src/features/workspace/TicketPanel.tsx:20-43 — current
const TURN = { out: 260, in: 340, delay: 70 } as const
oldEl.animate([rest, swing(-14 * dir, 38 * dir)], { duration: TURN.out, easing: 'cubic-bezier(0.3, 0, 1, 1)', fill: 'both' })
newEl.animate([swing(14 * dir, -38 * dir), rest], { duration: TURN.in, delay: TURN.delay, easing: ease, fill: 'backwards' })
```

## Target

- `const TURN = { out: 160, in: 240, delay: 0 } as const`  (total <= 240 ms).
- Both animations use `EASE.out` (`cubic-bezier(0.23, 1, 0.32, 1)`, from `lib/motion.ts` after plan 001; if
  plan 001 is not merged yet, inline that exact string once as `const ease`).
- Gentler swing: `swing(x, deg)` = `translateX(${x}%) rotateY(${deg}deg) scale(0.96)`; use `-10 * dir`/`26 * dir`
  for the outgoing and `10 * dir`/`-26 * dir` for the incoming.
- When the step was caused by a held key (`KeyboardEvent.repeat === true`), skip the animation entirely and
  swap the ticket instantly. Find where `turnTicket` is invoked (`grep -n turnTicket src`) and thread a
  `repeat`/`instant` flag from the keydown handler in `pages/Workspace.tsx` (the `onKey` effect that steps
  rows when `pictureOnly`).
- Keep: cancels the running turn when a new step arrives, reduced motion = no animation.

## Repo conventions to follow

- Compositor-only motion (transform/opacity) is already respected; keep it. Test file:
  `src/features/workspace/turnTicket.test.ts` (update expectations for the new durations/curve).

## Steps

1. Edit `TURN`, curves and swing values in `TicketPanel.tsx`.
2. Add the `instant` flag path (no `animate()` calls, just swap) and set it from `e.repeat`.
3. Update `turnTicket.test.ts`.

## Boundaries

- Do NOT remove the animation (the user explicitly asked for it). Do NOT touch the route transitions.
- No new dependencies. On drift, STOP and report.

## Verification

- **Mechanical**: typecheck, lint, `npm test`, `npx playwright test --project=chromium-desktop --workers=2 motion workspace-chrome`.
- **Feel check**: hide the table, tap ArrowRight once: a quick, crisp turn; tap repeatedly: each step cancels
  the previous cleanly; hold the key: tickets change with no animation and no stutter.
- **Done when**: all of the above hold and the unit test reflects 160/240 ms.
