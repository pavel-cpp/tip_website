# 007 — Panel-collapse snap, colour picker unfold, crossfade and will-change polish

- **Status**: DONE
- **Commit**: c8d7b7a
- **Severity**: LOW (additive)
- **Category**: Missed opportunities, Cohesion
- **Estimated scope**: 4 files

## Problem

1. Dragging the splitter handle past the collapse point hides a panel instantly, because the grid has
   `transition: none` while dragging (`workspace.css:94-99`, `.ws-grid[data-dragging]`): a state change teleports.
2. The in-page colour picker (`features/projects/ColorPicker.tsx`) mounts under the colour fields with no motion;
   the content below jumps.
3. `.tk-canvas` crossfade uses `linear` (`workspace.css:602,607`).
4. `.ph-chip` has a permanent `will-change: transform` (`features/projects/settings.css:341`).

## Target

1. `Splitter.tsx` already knows when `dragState` flips `collapsed`. Add `data-snap` to the grid for 240 ms
   after a flip (set from `Workspace.tsx` where `setSplit` runs, clear with a `setTimeout`, honour reduced
   motion), and CSS: `.ws-grid[data-dragging][data-snap] { transition: grid-template-columns var(--dur-base) var(--ease-in-out), grid-template-rows var(--dur-base) var(--ease-in-out); }`
   (declared after the `[data-dragging]` rule so it wins). Ratio changes without a flip stay instant.
2. Colour picker: `.cp { animation: cp-in var(--dur-fast) var(--ease-out) both; }`
   `@keyframes cp-in { from { opacity: 0; transform: translateY(-6px); } }` (in `settings.css`). No exit animation
   (it is unmounted instantly; acceptable for a small inline unfold).
3. `workspace.css:602` `linear` -> `var(--ease-out)`, `:607` `linear` -> `var(--ease-out)`.
4. Remove `will-change: transform` from `.ph-chip`; the drag already sets a transform inline.

## Repo conventions to follow

- Tokens from `tokens.css`; reduced-motion handled globally by `base.css` (plan 006 keeps fades).

## Steps

1. Implement 1-4 above (one commit per item).
2. Extend `e2e/specs/workspace-chrome.spec.ts` splitter test: after dragging to the edge, the panel is `inert`
   within 400 ms (already asserted) and no console errors.

## Boundaries

- Do NOT touch the splitter pointer maths in `split.ts`. No new dependencies. On drift, STOP and report.

## Verification

- **Mechanical**: typecheck, lint, `npm test`, `npx playwright test --project=chromium-desktop --workers=2 workspace-chrome settings-redesign`.
- **Feel check**: drag the handle to the edge: the panel eases away instead of vanishing; open a colour
  swatch: the picker settles in with a tiny rise; click rows: ticket canvas crossfade is clean.
- **Done when**: all four items are visible and tests pass.
