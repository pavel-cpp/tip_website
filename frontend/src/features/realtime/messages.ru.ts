import type { Message } from '../../i18n/types'

// Namespace owned by the realtime stream: realtime.*. Spread into i18n/ru.ts.
export const realtimeRu = {
  'realtime.conn.reconnecting': 'Переподключение…',
  'realtime.conn.offline': 'Нет связи',
  'realtime.online.label': {
    one: 'Сейчас онлайн: {count} коллега',
    few: 'Сейчас онлайн: {count} коллеги',
    many: 'Сейчас онлайн: {count} коллег',
    other: 'Сейчас онлайн: {count} коллег',
  },
  'realtime.toast.finished': 'Проект завершён — он стал доступен только для просмотра.',
  'realtime.someone': 'Коллега',
} as const satisfies Record<string, Message>
