// Print rules from docs/06-frontend.md section 6. These are constants, not project settings.

/** Ticket size on paper (7 x 4 cm), as in the desktop version. */
export const TICKET_MM = { w: 70, h: 40 } as const
/** Gap between tickets (the desktop version used 10 printer pixels). */
export const GAP_MM = 0.5
export const A4_MM = { w: 210, h: 297 } as const
export const PAGE_MARGIN_MM = 0
/**
 * Three 70 mm tickets plus two gaps are 211 mm, 1 mm wider than A4. The layout still has 3 columns
 * (as on desktop; the last ticket of a row may lose a millimetre), so the fit check allows this slack.
 */
export const OVERFLOW_TOLERANCE_MM = 1
/** Target aspect ratio (w/h) of project images, 7:4. */
export const TICKET_ASPECT = TICKET_MM.w / TICKET_MM.h

export interface Slot {
  page: number
  row: number
  col: number
}
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function fit(available: number, size: number, tolerance: number): number {
  return Math.max(1, Math.floor((available + GAP_MM + tolerance) / (size + GAP_MM)))
}

export const COLUMNS = fit(A4_MM.w - 2 * PAGE_MARGIN_MM, TICKET_MM.w, OVERFLOW_TOLERANCE_MM)
export const ROWS = fit(A4_MM.h - 2 * PAGE_MARGIN_MM, TICKET_MM.h, 0)
export const TICKETS_PER_PAGE = COLUMNS * ROWS

export function pageCount(tickets: number): number {
  return tickets <= 0 ? 0 : Math.ceil(tickets / TICKETS_PER_PAGE)
}

/** Flow: left to right, then down, then a new page. */
export function slotFor(index: number): Slot {
  const page = Math.floor(index / TICKETS_PER_PAGE)
  const within = index % TICKETS_PER_PAGE
  return { page, row: Math.floor(within / COLUMNS), col: within % COLUMNS }
}

/** Frame of the ticket on its page in millimetres; the image is stretched to fill it (object-fit: fill). */
export function slotRect(index: number): Rect {
  const { row, col } = slotFor(index)
  return {
    x: PAGE_MARGIN_MM + col * (TICKET_MM.w + GAP_MM),
    y: PAGE_MARGIN_MM + row * (TICKET_MM.h + GAP_MM),
    w: TICKET_MM.w,
    h: TICKET_MM.h,
  }
}

/** Splits item indexes into pages of TICKETS_PER_PAGE. */
export function paginate(count: number): number[][] {
  const pages: number[][] = []
  for (let i = 0; i < count; i++) {
    const { page } = slotFor(i)
    const bucket = pages[page] ?? []
    bucket.push(i)
    pages[page] = bucket
  }
  return pages
}

/**
 * CSS for the in-place print sheets: the sheets stay hidden on screen, and only the paper layout
 * (A4, zero margins, stretched images) lives in the print media block.
 */
export function printCss(): string {
  return [
    `@page { size: A4; margin: ${PAGE_MARGIN_MM}mm }`,
    '@media print {',
    '  html, body { margin: 0; background: #fff }',
    '  body > *:not(.print-sheets) { display: none !important }',
    '  .print-sheets { display: block }',
    `  .print-page { width: ${A4_MM.w}mm; height: ${A4_MM.h}mm; box-sizing: border-box; padding: ${PAGE_MARGIN_MM}mm; overflow: hidden; break-after: page; display: grid; grid-template-columns: repeat(${COLUMNS}, ${TICKET_MM.w}mm); grid-auto-rows: ${TICKET_MM.h}mm; gap: ${GAP_MM}mm; align-content: start }`,
    '  .print-page:last-child { break-after: auto }',
    `  .print-ticket { width: ${TICKET_MM.w}mm; height: ${TICKET_MM.h}mm; object-fit: fill; display: block; break-inside: avoid }`,
    '}',
  ].join('\n')
}
