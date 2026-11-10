# 001 — Replace the inverted easing tokens with strong ease-out / ease-in-out

- **Status**: DONE
- **Commit**: c8d7b7a
- **Severity**: HIGH
- **Category**: Easing & duration, Cohesion & tokens
- **Estimated scope**: 6 files, small

## Problem

The easing tokens are named backwards, so every EXIT animation starts slowly (ease-in), which delays
the exact moment the user is watching. Used 11 times as `var(--ease-out)`: modal close, popover close,
toast out, row delete, realtime avatar leave, etc. Five more curves are hand-typed in TypeScript.

```css
/* frontend/src/styles/tokens.css:142-144 — current */
--ease-standard: cubic-bezier(0.2, 0, 0, 1);
--ease-in: cubic-bezier(0, 0, 0, 1);          /* actually a strong ease-OUT, misnamed */
--ease-out: cubic-bezier(0.3, 0, 1, 1);       /* actually an EASE-IN: slow start */
```

`var(--ease-in)` is used in `frontend/src/styles/base.css:198` and `:255` (route exit animations).
`var(--ease-out)` is used in: `features/admin/admin.css:249`, `features/realtime/realtime.css:16`,
`features/workspace/workspace-mobile.css:409,470,492`, `features/workspace/workspace.css:113,391`,
`styles/ui.css:292,310,351,495`.

```ts
// frontend/src/components/Toast.tsx:99            easing: 'cubic-bezier(0.2, 0, 0, 1)',
// frontend/src/features/projects/useFlip.ts:47    easing: 'cubic-bezier(0.2, 0, 0, 1)'
// frontend/src/features/projects/useProjectDnd.ts:172  easing: 'cubic-bezier(0.2, 0, 0, 1)',
// frontend/src/features/workspace/TicketPanel.tsx:34   const ease = 'cubic-bezier(0.2, 0, 0, 1)'
// frontend/src/features/workspace/TicketPanel.tsx:38   easing: 'cubic-bezier(0.3, 0, 1, 1)',   <- ease-in on an exit
```

## Target

```css
/* frontend/src/styles/tokens.css */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);        /* strong ease-out: entering, exiting, default */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* strong ease-in-out: things moving on screen */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* iOS-like drawer / sheet curve */
--ease-standard: var(--ease-out);                  /* kept so the 74 existing uses keep working */
/* --ease-in is removed */
```

```ts
// frontend/src/lib/motion.ts — mirrors the CSS tokens, next to DURATION
export const EASE = {
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  inOut: 'cubic-bezier(0.77, 0, 0.175, 1)',
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const
```

## Repo conventions to follow

- Motion tokens live in `frontend/src/styles/tokens.css` (section "Motion"); JS mirrors live in
  `frontend/src/lib/motion.ts` (`DURATION`, `SPRING`). Docs: `docs/06-frontend.md` section 10.2.

## Steps

1. `tokens.css`: replace the three `--ease-*` lines above with the four lines in Target.
2. `base.css:198` and `:255`: `var(--ease-in)` -> `var(--ease-out)`.
3. `motion.ts`: add `EASE` as shown.
4. `Toast.tsx:99`: `easing: EASE.inOut` (the toast slides to a new slot: on-screen movement). Import `EASE`.
5. `useFlip.ts:47`: `easing: EASE.inOut`. `useProjectDnd.ts:172`: `easing: EASE.out` (a released card settling).
6. `TicketPanel.tsx`: `const ease = EASE.out`; the outgoing animation `easing: EASE.out` (was ease-in).
7. `docs/06-frontend.md` section 10.2: update the listed curve values (Russian text, keep wording, change numbers).

## Boundaries

- Do NOT change durations here. Do NOT touch any other CSS. Do NOT add dependencies.
- If a line does not match the excerpt above (drift since the commit stamp), STOP and report.

## Verification

- **Mechanical**: in `frontend/`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all pass;
  `grep -rn "ease-in)" src` returns nothing.
- **Feel check**: open and close a modal, a menu and a toast; closing must start fast (no "hesitation" at
  the start). Animations panel at 10%: the exit curve rises steeply from frame 1.
- **Done when**: no `--ease-in` anywhere, no hand-typed cubic-bezier outside `tokens.css`/`motion.ts`.
