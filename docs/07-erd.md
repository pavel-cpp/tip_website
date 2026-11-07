# 07. ERD — схема базы данных

Интерактивная диаграмма (плагин Obsidian **DBML ER Diagrams**, `dbml-erd`). Источник правды по DDL — [03-database.md](03-database.md);
эта диаграмма должна совпадать с миграциями `00001…00005`. При изменении схемы обновляем оба файла.

**Как читать.** 🔑 — PK, 🔗 — FK, `NN` — `NOT NULL`. На стороне «много» — «воронья лапка»; на стороне «один» — чёрта (FK `NOT NULL`)
или кружок (FK допускает `NULL`). Цвет шапки = домен: синий — пользователи, фиолетовый — роли и права, зелёный — проекты, оранжевый — участники, серый — аудит.
Таблицы можно перетаскивать, масштабировать колесом; положение сохраняется в комментариях `// @pos` внутри блока.

```dbml
// height: 900

Table users [headercolor: #1E5BB8] {
  id uuid [pk, note: 'DEFAULT uuidv7()']
  login text [not null, note: 'UNIQUE; строчные латиница, цифры, точка, дефис, подчёркивание; 3-32 символа']
  display_name text [not null, note: '1..80 символов']
  color text [not null, note: '#RRGGBB; по умолчанию #6cb4ff']
  locale text [not null, note: 'ru или uz; по умолчанию ru']
  theme text [not null, note: 'dark, light или system; по умолчанию dark']
  password_hash text [not null, note: 'argon2id (PHC-строка), необратимый хэш']
  password_temporary bool [not null, note: 'true после выдачи сервером пароля; UI рекомендует сменить']
  is_active bool [not null, note: 'false = деактивирован, токены отозваны в Redis']
  last_login_at timestamptz
  created_at timestamptz [not null]
  updated_at timestamptz [not null]
  Note: 'Пользователи. Роли: admin, worker.'
}

Table user_avatars [headercolor: #1E5BB8] {
  user_id uuid [pk, not null]
  mime text [not null]
  data bytea [not null, note: 'до 256 КБ, JPEG 256x256']
  sha256 text [not null, note: 'ETag и ?v= в avatarUrl']
  updated_at timestamptz [not null]
  Note: 'Аватар 1:1, лежит в БД ради атомарности и единого дампа.'
}

Table roles [headercolor: #7C3AED] {
  id uuid [pk, note: 'DEFAULT uuidv7()']
  name text [not null, note: 'UNIQUE; 2-50 символов']
  description text [not null]
  is_system bool [not null, note: 'admin, worker: нельзя удалить; admin нельзя править']
  created_at timestamptz [not null]
  updated_at timestamptz [not null]
  Note: 'Роли создаёт админ в админ-панели. Права роли хранятся в role_permissions.'
}

Table permissions [headercolor: #7C3AED] {
  code text [pk, note: 'например participant.edit; каталог задаётся кодом']
  grp text [not null, note: 'группа для UI']
  description text [not null]
  Note: 'Каталог прав. Синхронизируется из кода при старте tipd.'
}

Table role_permissions [headercolor: #7C3AED] {
  role_id uuid [pk, not null]
  permission text [pk, not null, note: 'PK составной (role_id, permission)']
  Note: 'Какие права даёт роль.'
}

Table user_roles [headercolor: #7C3AED] {
  user_id uuid [pk, not null]
  role_id uuid [pk, not null, note: 'PK составной (user_id, role_id); занятую роль не удалить']
  Note: 'Назначение ролей пользователям (несколько ролей, права объединяются).'
}

Table authz_state [headercolor: #7C3AED] {
  id smallint [pk, note: 'всегда 1']
  epoch bigint [not null, note: 'растёт при изменении ролей/прав; claim pe в access JWT']
  Note: 'Эпоха прав: устаревший access получает 401 TOKEN_STALE и обновляется.'
}

Table projects [headercolor: #1F8A4C] {
  id uuid [pk, note: 'DEFAULT uuidv7()']
  title text [not null, note: '1..120 символов']
  status project_status [not null, note: 'enum: active | finished; finished = read-only']
  finished_at timestamptz
  image_sha256 text [note: 'файл uploads/projects/sha256; поля image_* заданы все или ни одного']
  image_name text
  image_mime text
  image_w int
  image_h int
  image_bytes int
  next_number int [not null, note: 'счётчик номеров участников, не переиспользуется']
  version int [not null, note: 'optimistic concurrency']
  created_by uuid
  created_at timestamptz [not null]
  updated_at timestamptz [not null]
  Note: 'Проекты (конкурсы). Картинка хранится файлом, в БД только метаданные.'
}

Table project_placeholders [headercolor: #1F8A4C] {
  project_id uuid [pk, not null]
  key text [pk, not null, note: 'number | name | phone; PK составной (project_id, key)']
  font text [not null, note: 'из белого списка в приложении']
  size int [not null, note: '6..400']
  stroke int [not null, note: '0..50']
  color text [not null, note: '#RRGGBB']
  stroke_color text [not null, note: '#RRGGBB']
  bold bool [not null]
  italic bool [not null]
  underline bool [not null]
  x int [not null, note: 'px исходного изображения, центр текста']
  y int [not null]
  Note: '3 строки на проект: номер, имя, телефон.'
}

Table project_contributors [headercolor: #1F8A4C] {
  project_id uuid [pk, not null]
  user_id uuid [pk, not null, note: 'PK составной (project_id, user_id)']
  first_seen_at timestamptz [not null]
  last_seen_at timestamptz [not null]
  Note: 'Кто работал в проекте (аватары на карточке). На доступ НЕ влияет.'
}

Table participants [headercolor: #D9731A] {
  id uuid [pk, note: 'DEFAULT uuidv7()']
  project_id uuid [not null, note: 'UNIQUE (project_id, number)']
  number int [not null, note: 'больше 0, выдаётся из projects.next_number']
  name text [not null, note: 'до 200 символов; ПДн, не логируем']
  phone text [not null, note: 'до 40 символов; ПДн, не логируем']
  version int [not null, note: 'UPDATE ... WHERE version = $n, иначе 409']
  updated_by uuid
  created_at timestamptz [not null]
  updated_at timestamptz [not null]
  Note: 'Участники конкурса (строки таблицы).'
}

Table audit_log [headercolor: #6B7280] {
  id bigint [pk, note: 'GENERATED ALWAYS AS IDENTITY']
  at timestamptz [not null]
  actor_id uuid
  actor_login text [not null, note: 'снимок логина']
  action text [not null, note: 'user.create, project.finish, tickets.print ...']
  project_id uuid
  entity_id uuid
  meta jsonb [not null, note: 'только ID и числа, без имён и телефонов']
  ip inet
  Note: 'Журнал действий; хранится недолго: 30 дней и не более 100000 строк (диск 10 ГБ).'
}

Ref: user_avatars.user_id - users.id
Ref: user_roles.user_id > users.id
Ref: user_roles.role_id > roles.id
Ref: role_permissions.role_id > roles.id
Ref: role_permissions.permission > permissions.code
Ref: projects.created_by > users.id
Ref: project_placeholders.project_id > projects.id
Ref: project_contributors.project_id > projects.id
Ref: project_contributors.user_id > users.id
Ref: participants.project_id > projects.id
Ref: participants.updated_by > users.id
Ref: audit_log.actor_id > users.id
Ref: audit_log.project_id > projects.id
```

## Правила удаления (`ON DELETE`)

| Связь | Поведение |
|---|---|
| `user_avatars`, `user_roles.user_id`, `project_contributors.user_id` → `users` | `CASCADE` |
| `role_permissions` → `roles`, `permissions` | `CASCADE` |
| `user_roles.role_id` → `roles` | `RESTRICT` (занятую роль не удалить, `409 ROLE_IN_USE`) |
| `project_placeholders`, `project_contributors.project_id`, `participants` → `projects` | `CASCADE` (удаление проекта удаляет всё его содержимое) |
| `projects.created_by`, `participants.updated_by`, `audit_log.actor_id`, `audit_log.project_id` | `SET NULL` (история сохраняется; в аудите остаётся снимок `actor_login`) |

Пользователей физически не удаляем — только `is_active = false`; `CASCADE` по `users` — страховка для административной очистки.

## Типы-перечисления (в диаграмме показаны как обычные типы)

| Тип | Значения |
|---|---|
| `project_status` | `active`, `finished` |

> Плагин рисует подмножество DBML (без enum, составных ключей и `default`), поэтому ограничения вынесены в заметки к колонкам.
> Токенов в БД нет: access и refresh — JWT (HS256), их состояние хранится только в Redis ([02-architecture.md](02-architecture.md), 4.1).
> Служебная таблица `goose_db_version` (версия миграций) в диаграмму не входит.
