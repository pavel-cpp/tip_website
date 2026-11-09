# 04. API

Базовый префикс `/api/v1`. Формат — JSON (UTF-8), поля `camelCase`, время — RFC 3339 UTC.
Источник правды — **OpenAPI 3.1** `backend/api/openapi.yaml` (contract-first, пишется в Фазе 1); из него генерируются Go-DTO и интерфейс роутера, TS-типы и документация.
**Swagger UI — `/api/docs`**, спецификация — `/api/openapi.yaml` (раздел 8). Этот файл — человекочитаемый обзор.

## 1. Соглашения

* **Аутентификация:** `Authorization: Bearer <accessToken>` (JWT HS256, 15 мин), получаемый при логине. Продление — `POST /auth/refresh` по
  refresh-JWT в cookie (раздел 2). Состояние токенов (сожжённые refresh, отзывы) хранится только в Redis; **права пользователя лежат в claims access-токена** (`roles`, `perms`) — сервер проверяет их без обращения к БД. Все эндпоинты, кроме `/auth/login`, `/auth/refresh`, `/healthz`, `/readyz`, `/client-errors`, требуют токен.
* **CSRF:** API защищён самим Bearer-заголовком (браузер не подставит его сам); cookie-эндпоинты (`/auth/refresh`, `/auth/logout`) дополнительно
  проверяются по `Sec-Fetch-Site`/`Origin` (cross-origin → 403) и `SameSite=Strict`.
* **Request-ID:** сервер возвращает `X-Request-Id` (принимает входящий) — он же в логах.
* **Идентификаторы** — UUID. **Версии** строк (`version`) — целые, растут при каждой записи.
* **Кэширование:** `GET /participants`, `/projects/{id}/image`, аватары — `ETag` + `If-None-Match` (304).
* **Права** обозначены `perm` — коды из каталога (`02-architecture.md`, раздел 5.1). Роли и их права настраивает админ, поэтому набор прав пользователя берётся из токена, а не из жёстко заданной роли. Нет права → `403`; ресурс скрыт → `404`.

### Формат ошибки
```json
{ "error": { "code": "ROW_LOCKED", "message": "Строку редактирует Азам", "details": { "by": "9f1c…" } } }
```
| HTTP | `code` | Когда |
|---|---|---|
| 400 | `VALIDATION` | Невалидные данные (`details.fields` — по полям) |
| 401 | `UNAUTHENTICATED` | Нет/некорректный токен или токен в чёрном списке (выход, деактивация, смена пароля) → клиент идёт на `/login` |
| 503 | `AUTH_UNAVAILABLE` | Redis недоступен: для `login`/`refresh`/`logout` всегда; для остальных запросов — только при `REDIS_FAIL_MODE=closed` (по умолчанию `open`) — повторить позже |
| 401 | `TOKEN_EXPIRED` | Access-JWT истёк → клиент вызывает `/auth/refresh` и повторяет запрос один раз |
| 401 | `TOKEN_STALE` | Роли/права изменились (`pe` в токене устарела) → то же: `/auth/refresh` даёт новую пару с актуальными правами, затем повтор запроса |
| 401 | `REFRESH_INVALID` | Refresh просрочен, отсутствует в Redis, отозван, или обнаружено повторное использование (позже 10 с после ротации) → требуется новый вход |
| 401 | `BAD_CREDENTIALS` | Неверный логин/пароль (без уточнения, что именно) |
| 403 | `FORBIDDEN` | Нет права |
| 403 | `PASSWORD_CHANGE_REQUIRED` | **Только при `FORCE_PASSWORD_CHANGE=true`** (по умолчанию выключено — смена только рекомендуется): с временным паролем доступны лишь `/me`, `/me/password`, `/auth/refresh`, `/auth/logout` |
| 404 | `NOT_FOUND` | Нет ресурса / скрыт |
| 409 | `ROW_LOCKED` | Строку правит другой пользователь |
| 409 | `VERSION_CONFLICT` | `version` устарела; `details.current` — актуальная строка |
| 409 | `PROJECT_FINISHED` | Запись в завершённый проект |
| 409 | `LAST_ADMIN` | Нельзя убрать/деактивировать последнего активного админа |
| 409 | `ROLE_IN_USE` | Роль назначена пользователям — сначала снять (`details.users`) |
| 409 | `ROLE_SYSTEM` | Системную роль нельзя удалить; роль `admin` нельзя править |
| 413 | `TOO_LARGE` | Превышен лимит файла/тела |
| 415 | `UNSUPPORTED_MEDIA` | Не PNG/JPEG/… |
| 422 | `IMAGE_INVALID` | Файл не декодируется / слишком много пикселей |
| 429 | `RATE_LIMITED` | `Retry-After` в секундах |
| 507 | `DISK_LOW` | Мало свободного места |
| 500 | `INTERNAL` | В `message` — только request-id |

## 2. Auth и профиль

| Метод и путь | perm | Тело → ответ |
|---|---|---|
| `POST /auth/login` | — | `{login, password}` → `200 {accessToken, expiresIn, user}` + `Set-Cookie: tip_rt` — **пара access + refresh** (access в теле, refresh в httpOnly-cookie). Если `user.passwordTemporary = true`, UI при первом входе **рекомендует** сменить пароль (можно отложить) |
| `POST /auth/refresh` | cookie `tip_rt` | → `200 {accessToken, expiresIn}` + новый `tip_rt` — **новая пара**; старый refresh сжигается в Redis. Повтор старого refresh в течение 10 с идемпотентен, позже — reuse → `401 REFRESH_INVALID` и закрытие цепочки. Роли и права в новом access — актуальные из БД |
| `POST /auth/logout` | Bearer | → `204`: `jti` текущего access-токена попадает в **чёрный список Redis** (недействителен сразу), вся цепочка (`fam`) отзывается, cookie стирается. UI вызывает всегда |
| `GET /me` | auth | → `{user}` (с `roles` и `permissions`) |
| `PATCH /me` | `profile.edit` | `{displayName?, color?, locale?: "ru"\|"uz", theme?: "dark"\|"light"\|"system"}` → `{user}` |
| `POST /me/password` | `profile.edit` | `{current, new}` (≥ 8 символов) → `200 {accessToken, expiresIn}`; сбрасывает `passwordTemporary`; в Redis записывается отсечка `bl:user:{id}` (все прежние access и refresh пользователя недействительны), текущему клиенту выдаётся новая пара |
| `PUT /me/avatar` | `profile.edit` | `multipart` `file` (PNG/JPEG ≤ 2 МБ) → `{user}`; сервер приводит к 256×256 |
| `DELETE /me/avatar` | `profile.edit` | → `{user}` |
| `GET /users/{id}/avatar` | auth | → image, `ETag` |

```json
// User
{ "id":"…", "login":"a.sharafutdinov", "displayName":"Шарафутдин Азимов",
  "roles":[ { "id":"…", "name":"admin" } ],
  "permissions":[ "project.view", "project.create", "participant.edit", "role.manage", "…" ],
  "color":"#6cb4ff", "avatarUrl":"/api/v1/users/…/avatar?v=3f2a", "locale":"ru", "theme":"dark", "passwordTemporary":false }
```
`avatarUrl` — `null`, если аватара нет (клиент рисует инициалы «ША»). `permissions` — то же, что в claims `perms` access-токена: UI по ним показывает/скрывает элементы (решает всё равно сервер).

## 3. Администрирование: пользователи, роли, права

Пользователи (`user.view` / `user.manage`):

| Метод и путь | perm | Тело → ответ |
|---|---|---|
| `GET /admin/users` | `user.view` | → `[{user, isActive, lastLoginAt}]` |
| `POST /admin/users` | `user.manage` | `{login, displayName, roleIds?, color?}` → `201 {user, tempPassword}`: сервер **сам генерирует** случайный пароль (16 символов, `crypto/rand`), в ответе он показывается **один раз**, в БД остаётся только хэш; `passwordTemporary=true`. Без `role.manage` назначается только роль по умолчанию (`worker`); `roleIds` требует `role.manage` |
| `PATCH /admin/users/{id}` | `user.manage` | `{displayName?, isActive?}` → `{user}`. Деактивация: отсечка `bl:user:{id}` в Redis — access и refresh недействительны, WS закрывается; `LAST_ADMIN` |
| `PUT /admin/users/{id}/roles` | `role.manage` | `{roleIds:[…]}` (≥ 1 роли) → `{user}`; растёт эпоха прав `pe` (токены пользователя получат `401 TOKEN_STALE` и обновятся); `LAST_ADMIN` |
| `POST /admin/users/{id}/reset-password` | `user.manage` | → `{tempPassword}`: **новый** случайный пароль (один раз), старый перестаёт работать; отсечка `bl:user:{id}` в Redis (его токены недействительны), `passwordTemporary=true` — при следующем входе UI порекомендует сменить его на свой |

Роли и права (`role.manage`):

| Метод и путь | Тело → ответ |
|---|---|
| `GET /admin/permissions` | → каталог прав `[{code, group, description, requires:[…]}]` (для матрицы чекбоксов; `requires` — прямые зависимости) |
| `GET /admin/roles` | → `[Role]` (с числом пользователей) |
| `POST /admin/roles` | `{name, description, permissions:[…]}` → `201 {role}`; сервер добавляет зависимые права (`participant.edit` ⇒ `participant.view` …) |
| `GET /admin/roles/{id}` | → `{role}` + список пользователей роли |
| `PATCH /admin/roles/{id}` | `{name?, description?, permissions?}` → `{role}`; растёт эпоха прав. Роль `admin` править нельзя (`ROLE_SYSTEM`) |
| `DELETE /admin/roles/{id}` | → `204`; `ROLE_IN_USE` / `ROLE_SYSTEM` |

```json
// Role
{ "id":"…", "name":"Старший оператор", "description":"Оператор + удаление и импорт", "isSystem":false,
  "permissions":[ "project.view", "participant.view", "participant.edit", "participant.print",
                  "participant.export", "participant.delete", "participant.import" ],
  "userCount": 3 }
```

Служебное (`audit.view`, `system.view`):

| Метод и путь | Тело → ответ |
|---|---|
| `GET /admin/audit?limit=50&before=<id>&projectId=&actor=&action=` | (`audit.view`) → `{items:[…], next}` (в т.ч. `role.create/update/delete`, `user.roles.set` с добавленными/снятыми правами; для действий над учётными записями в `meta.login` записывается логин цели, без других персональных данных; `action` — точный код действия) |
| `GET /admin/system` | (`system.view`) → `{version, uptime, db:{sizeBytes, pool}, disk:{free, total}, retention:{obsDays, auditDays}, uploads:{sizeBytes}, links?:{swagger?, grafana?}, checks:[{name, status, detail}]}` — «Состояние»: Postgres, Redis, диск, Loki, время последнего локального и внешнего бэкапа; проблемы показываются красной плашкой в админ-панели |

## 4. Проекты

| Метод и путь | perm | Тело → ответ |
|---|---|---|
| `GET /projects?status=active\|finished&q=` | `project.view` (`finished` — ещё `project.view_finished`) | → `[ProjectCard]`; без `project.view_finished` возвращаются только `active` |
| `POST /projects` | `project.create` | `{title}` → `201 {project}` (плейсхолдеры по умолчанию) |
| `GET /projects/{id}` | `project.view` | → `{project}` (в нём `contributors` — кто правил раньше и `online` — кто сейчас подключён к проекту) |
| `PUT /projects/order` | `project.update` | `{ids:[…]}` — общий для команды порядок проектов (last write wins; чужие и скрытые id игнорируются); запись аудита `project.reorder` |
| `PATCH /projects/{id}` | `project.update` | `{title?, placeholders?}` + `version` → `{project}` |
| `PUT /projects/{id}/image` | `project.update` | `multipart` `file` → `{project}`; 413/415/422/507 при ошибках |
| `GET /projects/{id}/image` | `project.view` | → оригинал, `ETag=sha256`, `immutable`; `?size=thumb` — миниатюра 480 px JPEG (создаётся при загрузке, лежит рядом как `<sha>.thumb`); в JSON проекта поле `image.thumbUrl` — для карточек списка, чтобы не качать оригиналы |
| `POST /projects/{id}/finish` · `/reopen` | `project.finish` | → `{project}` |
| `DELETE /projects/{id}` | `project.delete` | → `204` (необратимо; аудит) |

```json
// Project
{ "id":"…", "title":"Tashkent City — розыгрыш BMW", "status":"active", "version":4,
  "image": { "url":"/api/v1/projects/…/image?v=ab12", "name":"bmw-tashkent-city.jpg", "w":1024, "h":768, "bytes":2202009 },
  "placeholders": {
    "number": { "font":"Montserrat","size":34,"stroke":2,"color":"#FFFFFF","strokeColor":"#141619",
                "bold":true,"italic":false,"underline":false,"x":512,"y":120 },
    "name":   { "…": "…" }, "phone": { "…": "…" } },
  "contributors": [ { "id":"…", "displayName":"Азам Турсунов", "color":"#ffb84d", "avatarUrl":null } ],
  "participantCount": 12, "createdAt":"2026-11-01T09:00:00Z" }
// ProjectCard = краткое подмножество (id, title, status, image.url, online, counts); online — только пользователи, подключённые к проекту прямо сейчас
```

## 5. Участники

| Метод и путь | perm | Тело → ответ |
|---|---|---|
| `GET /projects/{id}/participants?q=` | `participant.view` | → `{items:[Participant], rev}`; `ETag`; без `q` отдаются все строки (≤ 20 000) |
| `POST /projects/{id}/participants` | `participant.edit` | `{count}` (1…5000 пустых) **или** `{items:[{name,phone}]}` → `201 {items}` |
| `PATCH /participants/{id}` | `participant.edit` | `{name?, phone?, version}` → `{item}`; `409 ROW_LOCKED/VERSION_CONFLICT` |
| `POST /projects/{id}/participants/printed` | `participant.print` | `{ids:[…]}` → `204`: запись в аудит «напечатано» (только ID); состояние строк не меняется |
| `POST /projects/{id}/participants/delete` | `participant.delete` | `{ids:[…]}` → `{deleted:n}` |
| `POST /projects/{id}/participants/clear` | `participant.clear` | `{confirmTitle}` (должно совпасть с названием) → `{deleted:n}` |
| `POST /projects/{id}/participants/import` | `participant.import` | `multipart` XLSX/CSV, `mode=append\|replace`; `?dryRun=1` → предпросмотр ошибок |
| `GET /projects/{id}/export.xlsx` · `export.csv` | `participant.export` | → файл (номер, имя, телефон) |

```json
// Participant
{ "id":"…", "projectId":"…", "number":5, "name":"Шарафутдин Азимов", "phone":"+7 926 071-91-98",
  "version":7, "updatedAt":"2026-11-07T10:11:12Z" }
```
Все записи в завершённый проект → `409 PROJECT_FINISHED`. Занятость строки (обводка цветом редактирующего и подсказка «Редактирует Азам») берётся не из этого API, а из presence (WebSocket).

## 6. Служебные

| Путь | Доступ | Назначение |
|---|---|---|
| `GET /healthz` | публичный | Liveness (процесс жив) |
| `GET /readyz` | публичный | Readiness (ping Postgres и Redis, доступность `DATA_DIR`) |
| `POST /client-errors` | публичный, rate-limit, ≤ 8 КБ | Ошибки фронтенда → структурные логи (`{message, stack, url, ua, release}`) |
| `GET :9090/metrics`, `/debug/pprof/*` | **внутренняя сеть** | Prometheus, профилирование |

## 7. WebSocket

`GET /api/v1/projects/{id}/ws` — апгрейд, проверка `Origin`. **Токен в URL не передаётся** (попал бы в access-логи):
первым кадром клиент обязан отправить `auth`. Нет `auth` за 5 с, неверный токен или нет права `project.view` → закрытие `1008`. Права соединения берутся из `perms` токена: данные — `participant.view`, захват локов — `participant.edit`.
Кадры — текстовые JSON. Общий вид: `{"t":"<тип>", …}`. Лимиты: ≤ 4 КБ, ≤ 20 сообщений/с.

### Клиент → сервер
| `t` | Поля | Смысл |
|---|---|---|
| `auth` | `token` | **Первый кадр** — access-JWT. Повторяется после каждого `/auth/refresh` и в ответ на `reauth`; не продлён до `exp` → `1008` |
| `ping` | — | Heartbeat раз в 15 с; продлевает все локи клиента. Сервер отвечает кадром `{t:"pong"}`: клиент по нему отличает живое соединение от «зависшего» (таймаут ожидания 10 с) |
| `cursor` | `rowId?`, `field?` | «Я на этой строке/ячейке» (не эксклюзивно). `rowId=null` — снять |
| `lock.acquire` | `rowId` | Начать редактирование строки |
| `lock.release` | `rowId` | Закончить (blur/Enter/Esc) |

### Сервер → клиент
| `t` | Поля | Смысл |
|---|---|---|
| `hello` | `you`, `peers:[{id,displayName,color,avatarUrl}]`, `cursors:{userId:{rowId,field}}`, `locks:{rowId:{by,expiresAt}}`, `serverTime` | Первое сообщение; после него клиент делает resync строк |
| `reauth` | — | Роли/права изменились (эпоха `pe` выросла): клиент обновляет пару и присылает новый `auth` в течение 5 с, иначе `1008` |
| `presence` | `peers` | Кто онлайн (аватары в шапке) |
| `cursor` | `userId`, `rowId?`, `field?` | Курсор другого участника (его цвет — из профиля) |
| `lock` / `unlock` | `rowId`, `by`, `expiresAt` | Строка заблокирована/освобождена: `by` — id редактирующего (имя, цвет и аватар клиент берёт из `peers`) → обводка цветом пользователя и подсказка «Редактирует Азам» |
| `lock.denied` | `rowId`, `by` | Ответ на `lock.acquire`, если занято |
| `rows.upsert` | `items:[Participant]` | Строки изменены/добавлены (применять, если `version` больше локальной) |
| `rows.delete` | `ids` | Строки удалены |
| `project.updated` | `project` | Изменён проект (настройки, статус `finished` → UI переходит в read-only) |
| `error` | `code`, `message` | Нарушение лимитов и т.п.; при `RATE_LIMITED` соединение закрывается |

### Жизненный цикл
1. Клиент подключается → шлёт `auth` → `hello` → `GET /participants` (resync) → рендер.
2. Закрытие сервером: `1013` (медленный клиент/перегрузка), `1008` (нет/просрочен токен, нет прав, пользователь деактивирован), `1001` (рестарт).
3. Клиент переподключается с экспоненциальным backoff + jitter (1 с → 15 с); после успеха — снова resync.
4. На iOS/Safari при `visibilitychange`→visible и `pageshow` — принудительный reconnect и resync.
5. Если `lock` не продлён 45 с — сервер снимает его и рассылает `unlock`.

## 8. OpenAPI и Swagger

* **Contract-first:** `backend/api/openapi.yaml` (OpenAPI 3.1) пишется до кода. Из него `oapi-codegen` генерирует Go-типы DTO и интерфейс роутера chi (`ServerInterface`) в `handler/http/gen/`,
  а `openapi-typescript` — типы и клиент для фронтенда. Handler реализует `ServerInterface`; ручные DTO не пишутся, расхождение кода и спецификации невозможно.
* **Swagger UI:** `GET /api/docs` (встроен в бинарник через `go:embed`, без CDN), спецификация — `GET /api/openapi.yaml`. Кнопка **Authorize** принимает access-JWT (`bearerAuth`),
  поэтому «Try it out» работает на реальных эндпоинтах; логин делается через `POST /auth/login` прямо в Swagger.
* **Схемы безопасности в спецификации:** `bearerAuth` (HTTP bearer, формат JWT) для всего API и `refreshCookie` (apiKey in cookie `tip_rt`) для `/auth/refresh`.
* **Расширение `x-required-permissions`** на каждой операции перечисляет код(ы) права из каталога (`participant.edit`, `role.manage` …). Из него строится таблица прав в документации,
  а контрактный тест сверяет, что каждый защищённый маршрут действительно проверяет заявленное право (пользователь без права получает 403).
* Ошибки описаны единой схемой `Error` и компонентами ответов (`401 TOKEN_EXPIRED/TOKEN_STALE`, `403`, `409 ROW_LOCKED` …); WebSocket-протокол описывается в `info` спецификации и в разделе 7 этого файла.
* **Доступность:** переменная `SWAGGER_ENABLED` (по умолчанию `true`). Спецификация не секрет, а выполнить запрос без JWT нельзя; на публично доступном проде рекомендуется выключить
  или закрыть Caddy (basic-auth/VPN). Для `/api/docs` действует отдельная CSP (Swagger UI требует inline-скрипт инициализации), остальное приложение — строгая CSP.
* **CI:** линтер спецификации (`redocly lint`/`vacuum`), проверка дрейфа (`task gen` + `git diff --exit-code`), контрактные тесты хендлеров против схемы.
