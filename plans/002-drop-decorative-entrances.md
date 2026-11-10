# 002 — Remove decorative entrance motion that fires constantly

- **Status**: DONE
- **Commit**: c8d7b7a
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 3 CSS files

## Problem

Every avatar in the product replays a `scale(0.6)` pop on each mount (top bar, rows, cards, admin lists):
motion with no purpose on an element seen hundreds of times a day. Project cards also replay a staggered
rise every time the list mounts, in parallel with the route View Transition that already animates that page
(double motion).

```css
/* frontend/src/styles/ui.css:223 — current, inside .avatar */
animation: pop-in var(--dur-base) var(--ease-standard) both;
/* frontend/src/features/projects/projects.css:57-61 — current, inside .project-card */
transition: transform var(--dur-fast) var(--ease-standard);
animation: card-in var(--dur-base) var(--ease-standard) backwards;
animation-delay: min(calc(var(--i, 0) * 30ms), 180ms);
/* frontend/src/features/admin/admin.css:239-240 — stagger has no upper bound in CSS */
animation: row-in var(--dur-base) var(--ease-standard) both;
animation-delay: calc(var(--i, 0) * 30ms);
```

Presence avatars keep their own pop through `.rt-online-item` (`features/realtime/realtime.css:10`,
keyframes `rt-pop-in`), so removing the generic one does not lose the "colleague arrived" signal.

## Target

```css
/* ui.css: .avatar loses the animation line entirely (keep border etc.) */
/* projects.css: .project-card keeps only the hover transition */
transition: transform var(--dur-fast) var(--ease-out);
/* the card-in animation, its animation-delay and @keyframes card-in are deleted */
/* admin.css: .row-enter */
animation: row-in var(--dur-base) var(--ease-out) both;
animation-delay: min(calc(var(--i, 0) * 30ms), 180ms);
```

Keep `@keyframes pop-in` only if still referenced by `admin.css:85,517` and `auth/auth.css:98` (they are
single rare elements; leave them). Delete `card-in` keyframes and every `--i` write that only fed it
(search `--i` in `ProjectCard.tsx`; keep it if another rule reads it).

## Repo conventions to follow

- Motion tokens in `src/styles/tokens.css`; entrance keyframes in `styles/base.css` (`fade-in`, `fade-up`).
- Exemplar of motion that is justified: `.rt-online-item` in `features/realtime/realtime.css:8-18`.

## Steps

1. `ui.css`: delete line 223 (`animation: pop-in ...` in `.avatar`).
2. `projects.css`: apply the Target block; delete `@keyframes card-in`.
3. `ProjectCard.tsx`: remove the `--i` style only if nothing else reads it (`grep -rn "var(--i" src`).
4. `admin.css:239-240`: apply Target.
5. Update snapshots only if a visual spec changes (it should not: no layout change).

## Boundaries

- Do NOT touch realtime.css, auth.css, or the realtime avatar animation.
- Do NOT change hover or drag behaviour of cards.
- No new dependencies. On drift, STOP and report.

## Verification

- **Mechanical**: `npm run typecheck`, `npm run lint`, `npm test`; `npx playwright test --project=chromium-desktop --workers=2 projects projects-order realtime`.
- **Feel check**: reload the list: cards do not rise one after another; opening a project still morphs the card
  into the workspace; avatars appear without scaling; a colleague joining still pops into the top-bar group.
- **Done when**: `grep -n "pop-in" src/styles/ui.css` shows only the keyframes definition (or nothing if unused).
