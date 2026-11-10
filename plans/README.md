# Animation plans (desktop)

Source: `improve-animations` audit of `frontend/` at commit c8d7b7a. Phones are out of scope for now.

| # | Title | Severity | Status |
|---|---|---|---|
| 001 | Replace the inverted easing tokens with strong ease-out / ease-in-out | HIGH | DONE |
| 002 | Remove decorative entrance motion that fires constantly | HIGH | DONE |
| 003 | Tooltips: instant after the first one | MEDIUM | DONE |
| 004 | Page-turn of the ticket: faster, ease-out, skipped on key repeat | MEDIUM | DONE |
| 005 | Shorten sibling route transitions; stop animating layout for the panel collapse | MEDIUM | DONE |
| 006 | Reduced motion keeps short opacity fades | MEDIUM | DONE |
| 007 | Panel-collapse snap, colour picker unfold, crossfade and will-change polish | LOW | DONE |
| 008 | Measured lag fixes; 1:1 splitter, flat ticket slide, morph route transitions | HIGH | DONE |

## Order and dependencies

1. 001 first (adds `--ease-out`, `--ease-in-out`, `--ease-drawer`, `EASE`); everything else uses these tokens.
2. 002, 003, 006 touch `styles/ui.css`, `styles/base.css` (reduced-motion block), `Tooltip.tsx`, `projects.css`, `admin.css`.
3. 004, 005, 007 touch `TicketPanel.tsx`, `base.css` (route transitions), `workspace.css`, `Splitter`, `settings.css`.
   Groups 2 and 3 are independent of each other and may run in parallel after 001.
