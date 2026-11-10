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
  'realtime.follow.jump': 'Перейти к {name}',
  'realtime.follow.start': 'Следить',
  'realtime.follow.stop': 'Не следить',
  'realtime.follow.close': 'Закрыть',
  'realtime.follow.idle': '{name} пока не выбрал строку',
  'realtime.follow.viewing': '{name} смотрит строку № {number}',
  'realtime.follow.editingName': '{name} редактирует имя в строке № {number}',
  'realtime.follow.editingPhone': '{name} редактирует телефон в строке № {number}',
  'realtime.follow.editingRow': '{name} редактирует строку № {number}',
} as const satisfies Record<string, Message>
