# 005 — Shorten sibling route transitions; stop animating layout for the panel collapse

- **Status**: DONE
- **Commit**: c8d7b7a
- **Severity**: MEDIUM
- **Category**: Easing & duration, Performance
- **Estimated scope**: 2 CSS files

## Problem

1. Switching between admin screens (hit many times a day) takes 60 ms delay + 360 ms = 420 ms with a 6 px blur.
2. Hiding or restoring a work panel animates `grid-template-columns`/`grid-template-rows` for 360 ms: layout on
   every frame with a virtualized table and a canvas inside.

```css
/* frontend/src/styles/base.css:254-262 — current */
:root[data-nav="sibling"]::view-transition-old(page) { animation: vt-out-depth var(--dur-fast) var(--ease-in) both; }
:root[data-nav="sibling"]::view-transition-new(page) { animation: vt-in-depth var(--dur-slow) var(--ease-standard) both; animation-delay: 60ms; }
/* frontend/src/features/workspace/workspace.css:90-92 — current, .ws-grid */
transition: grid-template-columns var(--dur-slow) var(--ease-standard), grid-template-rows var(--dur-slow) var(--ease-standard);
```

## Target

```css
/* base.css */
:root[data-nav="sibling"]::view-transition-old(page) { animation: vt-out-depth var(--dur-fast) var(--ease-out) both; }
:root[data-nav="sibling"]::view-transition-new(page) { animation: vt-in-depth var(--dur-base) var(--ease-out) both; animation-delay: 30ms; }
/* @keyframes vt-out-depth / vt-in-depth: blur 6px -> 4px */
/* workspace.css .ws-grid */
transition: grid-template-columns var(--dur-base) var(--ease-in-out), grid-template-rows var(--dur-base) var(--ease-in-out);
/* .ws-slot gets: contain: layout paint;  so the inner panel is not re-laid-out through the parent's changes */
```

The hero morph (`::view-transition-group(hero)`, `base.css` ~line 270) and the sheet (`data-sheet`) keep
`var(--dur-slow)` (360 ms): they are large spatial transitions (modal/drawer budget 200-500 ms), but change their
curve from `var(--ease-standard)` to `var(--ease-drawer)` (`cubic-bezier(0.32, 0.72, 0, 1)`), defined by plan 001's
token additions (if plan 001 is not merged yet, add the `--ease-drawer` token yourself exactly as written there).

## Repo conventions to follow

- Only `opacity`/`transform`/`filter` (<= 20 px blur) inside View Transition keyframes. Selectors for route
  transitions are all under `@media (hover: hover) and (pointer: fine) and (min-width: 700px)` gating plus
  `lib/viewTransition.ts` (`desktopMotion()`); keep that gating.

## Steps

1. Apply the `base.css` changes (sibling timings, blur 4px, hero and sheet curve to `--ease-drawer`).
2. Apply the `workspace.css` change on `.ws-grid`, add `contain: layout paint` on `.ws-slot`
   (verify the ticket canvas and table scroll still render; if `contain` clips anything, drop it and report).
3. Refresh the visual baselines only if they change, and look at them.

## Boundaries

- Do NOT change the splitter drag (`.ws-grid[data-dragging]` stays `transition: none`).
- Do NOT touch mobile CSS or the JS in `viewTransition.ts`. No new dependencies. On drift, STOP and report.

## Verification

- **Mechanical**: typecheck, lint, build; `npx playwright test --project=chromium-desktop --workers=2 motion workspace-chrome visual settings-redesign`.
- **Feel check**: admin -> system -> account: a short settle, no lingering fade; hide/restore the table by
  dragging to the edge: smooth, no jank while rows scroll; list -> project morph still reads as one object.
- **Done when**: the above holds and no layout property is animated except the single grid transition.
