import type { Message } from '../../i18n/types'
import type { realtimeRu } from './messages.ru'

// Uzbek, Latin script (oʻ and gʻ use U+02BB). Needs a native-speaker review.
export const realtimeUz: Record<keyof typeof realtimeRu, Message> = {
  'realtime.conn.reconnecting': 'Qayta ulanmoqda…',
  'realtime.conn.offline': 'Aloqa yoʻq',
  'realtime.online.label': {
    one: 'Hozir onlayn: {count} hamkasb',
    other: 'Hozir onlayn: {count} hamkasb',
  },
  'realtime.toast.finished': 'Loyiha yakunlandi — endi faqat koʻrish mumkin.',
  'realtime.someone': 'Hamkasb',
}
