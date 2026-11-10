# 006 — Reduced motion: keep short opacity fades, drop movement

- **Status**: DONE
- **Commit**: c8d7b7a
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 1 CSS file (+ a small test)

## Problem

Both the OS media query and the in-app "less motion" setting cancel every animation and transition
(duration 0.01 ms), including harmless opacity fades that tell the user something appeared or left. Reduced
motion should mean fewer and gentler animations, not none.

```css
/* frontend/src/styles/base.css:72-98 — current (the media query and the [data-reduce-motion] twin) */
*, *::before, *::after { animation-duration: 0.01ms !important; animation-delay: 0s !important;
  animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; ... }
::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
```

## Target

Keep the global kill for movement, then restore opacity-only behaviour for the overlays that signal state:

```css
/* inside BOTH the @media (prefers-reduced-motion: reduce) block and the :root[data-reduce-motion="true"] rules,
   written once as a shared selector list where possible */
.overlay                      { animation: fade-in 120ms linear both !important; }
.overlay[data-state="closed"] { animation: fade-out 100ms linear both !important; }
.modal                        { animation: fade-in 120ms linear both !important; }
.overlay[data-state="closed"] .modal { animation: fade-out 100ms linear both !important; }
.popover                      { animation: fade-in 120ms linear both !important; }
.popover[data-state="closed"] { animation: fade-out 100ms linear both !important; }
.toast                        { animation: fade-in 120ms linear both !important; }
.toast[data-state="closed"]   { animation: fade-out 100ms linear both !important; }
.tooltip                      { animation: fade-in 100ms linear both !important; }
```

(`fade-in` and `fade-out` already exist in `styles/base.css` and `styles/ui.css`.) The toast countdown bar,
spinners and View Transitions stay disabled. `lib/motion.ts` `usePresence` already shortens the unmount
delay to 0 when reduced motion is on; change it to keep `exitMs` = 100 so the fade-out can play (also change
`useReducedMotion` consumers only if a test breaks).

## Repo conventions to follow

- The two reduced-motion rule sets are duplicated on purpose (OS query + user setting): edit both.

## Steps

1. `base.css`: append the Target block to both rule sets.
2. `motion.ts`: in `usePresence`, use `prefersReducedMotion() ? 100 : exitMs`.
3. Add/adjust a unit test for `usePresence` if one exists; otherwise cover it in an e2e assertion: with the
   Playwright `reducedMotion: 'reduce'` context, opening a modal ends with opacity 1 and no `transform`.

## Boundaries

- Do NOT re-enable any transform movement, parallax, blur, or View Transition. No new dependencies.
- On drift, STOP and report.

## Verification

- **Mechanical**: typecheck, lint, `npm test`, `npx playwright test --project=chromium-desktop --workers=2 nav-motion a11y-round4`.
- **Feel check**: Rendering panel -> emulate `prefers-reduced-motion: reduce`: a modal fades in and out
  briefly, nothing slides or scales; toggling the in-app "less motion" setting gives the same.
- **Done when**: both paths pass the above.
