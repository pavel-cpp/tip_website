# 003 — Tooltips: instant after the first one (skip-delay group)

- **Status**: TODO
- **Commit**: c8d7b7a
- **Severity**: MEDIUM
- **Category**: Easing & duration (tooltip delay), Purpose & frequency
- **Estimated scope**: 2 files

## Problem

Every tooltip waits 300 ms and then plays `pop-open`, including when the pointer slides between neighbouring
toolbar buttons. After the first tooltip opened, the next ones should appear instantly with no animation.

```tsx
// frontend/src/components/Tooltip.tsx:12-13,47
const HOVER_DELAY = 300
const TOUCH_HIDE = 2500
timer.current = setTimeout(() => setOpen(true), HOVER_DELAY)
```
```css
/* frontend/src/styles/ui.css:443 — current, inside .tooltip */
animation: pop-open var(--dur-fast) var(--ease-standard) both;
```

## Target

- Module-level `let lastClosedAt = 0` in `Tooltip.tsx`; when any tooltip closes (pointer leave or blur), set
  `lastClosedAt = performance.now()`.
- On pointer enter: `const warm = performance.now() - lastClosedAt < 500`; if `warm`, open immediately
  (delay 0) and mark the element `data-instant="true"`; otherwise delay `HOVER_DELAY` (300 ms, unchanged).
- Focus keeps opening immediately (unchanged) and is also `data-instant`.
- CSS: `.tooltip[data-instant="true"] { animation: none; }`. The cold tooltip keeps
  `animation: pop-open var(--dur-fast) var(--ease-out) both;`.

## Repo conventions to follow

- Tooltip is already origin-aware through `useFloating` (`style.transformOrigin`). Keep that.
- Keep the wrapper-span structure and the `biome-ignore` comment.

## Steps

1. `Tooltip.tsx`: add `lastClosedAt`, a `instant` state set when opening warm or via focus, reset when closing;
   pass `data-instant={instant || undefined}` on the tooltip div.
2. `ui.css`: add the `data-instant` rule and swap `--ease-standard` for `--ease-out` on `.tooltip`.
3. Add a unit test in `components/components.test.tsx`: hover A, leave, hover B within 500 ms -> B open at 0 ms
   (use fake timers), and hover after 600 ms -> needs the 300 ms delay.

## Boundaries

- Do NOT change touch behaviour (tap to toggle, `TOUCH_HIDE`). No new dependencies.
- On drift, STOP and report.

## Verification

- **Mechanical**: typecheck, lint, `npm test`.
- **Feel check**: in the workspace toolbar, hover the first icon button (short wait, animates), then slide to the
  next: its tooltip appears at once without scaling. Wait a second, hover again: delayed and animated.
- **Done when**: the unit test passes and the behaviour above is observed.
