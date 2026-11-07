export type PlaceholderKey = 'number' | 'name' | 'phone'
export const PLACEHOLDER_KEYS: readonly PlaceholderKey[] = ['number', 'name', 'phone']

/** Text style and position of one ticket field; x/y are the text centre in source-image pixels. */
export interface TicketPlaceholder {
  font: string
  size: number
  stroke: number
  color: string
  strokeColor: string
  bold: boolean
  italic: boolean
  underline: boolean
  x: number
  y: number
}

export type TicketPlaceholders = Record<PlaceholderKey, TicketPlaceholder>
export type TicketValues = Record<PlaceholderKey, string>

/** The fonts the backend accepts (domain.AllowedFonts); all are bundled with the frontend. */
export const TICKET_FONTS = [
  'Montserrat',
  'Roboto',
  'Open Sans',
  'Inter',
  'PT Sans',
  'Oswald',
  'Playfair Display',
  'Arimo',
] as const

export const PLACEHOLDER_LIMITS = { minSize: 6, maxSize: 400, minStroke: 0, maxStroke: 50 } as const
