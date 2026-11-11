# 009 — Route transitions rewritten as an own FLIP morph engine (no View Transitions)

- **Status**: DONE
- **Commit**: see `git log` (stream I)
- **Severity**: HIGH
- **Category**: Performance, Physicality & origin, Cohesion, Cross-browser
- **Estimated scope**: `lib/routeMotion.ts` (new), `Shell.tsx`, `base.css`, morph marks on 9 components, e2e

## Why

The View Transitions based route motion looked different (and lagged) per browser: full-page snapshot layers
were the measured cost, Safari and older engines had no support at all. The user's verdict: forget it, make the
interface visibly rearrange itself, smooth, never linear, in Chrome, Firefox and Safari.

## What it is

An own engine on the Web Animations API (`src/lib/routeMotion.ts`), the same code path in every browser:

1. **Capture** (before the history entry changes: patched `pushState`, a `popstate` listener registered ahead of
   the router's, `replaceState` only when leaving `/login`): rects of `[data-morph]` elements, ghosts of them
   (text, card surface, picture), a sanitised clone of the outgoing `main.page` and of the top bar slot.
2. **Play** (layout effect in `Shell`, after the route committed, before paint): the clone sits on top of the new
   page, opaque; when the new page has its frame (no loading skeleton, or a marked element exists; at most 400 ms)
   the clone settles out (170 ms), ghosts fly old rect -> new rect (340 ms, `--ease-drawer`) with the real
   element fading in under them, and the page content is revealed block by block (240 ms, 40 ms stagger, 5 blocks).
   Late arrivals (crumbs set by effects, a thumbnail) join for 450 ms through a MutationObserver.
3. **Interruption/failure**: a new navigation cancels everything and removes all layers; every entry point is in
   try/catch and falls back to "no animation"; nothing is awaited on the navigation path.

Shared elements: `hero:<id>` (card <-> workspace surface, constant corner radius), `title:<id>` (card title ->
workspace crumb -> settings title field, uniform text scale), `ticket:<id>` (card thumbnail -> workspace stage ->
settings preview), `heading` (admin/profile/list headings); `data-reveal="side"` slides the settings panel in.
Direction: deeper rises in, shallower settles back, siblings slide along the menu order. Reduced motion: 120 ms
opacity fade; touch devices keep the CSS `.route-enter` fade.

## Removed

`installRouteTransitions`, `data-nav/hero/morph/sheet/rank`, all route `::view-transition-*` and
`view-transition-name` rules, the `viewTransition` router options. View Transitions stay for theme/language
switches (`withViewTransition`).

## Side fix

`useHeadingTitle` bound its observer to a main element that did not exist yet while a lazy screen was loading,
so `document.title` stayed at the app name (seen in Firefox). It now follows the element through a callback ref.

## Verification

`e2e/specs/route-motion.spec.ts` (all three desktop browsers; leaves no layers/animations, ghost exists mid-flight,
interruption, reduced motion, back/forward), unit tests for the maths in `routeMotion.test.ts`, frames recorded
with `E2E_FRAMES=1` (paused WAAPI timeline works in every engine). Frame-time numbers are in the stream I report.
