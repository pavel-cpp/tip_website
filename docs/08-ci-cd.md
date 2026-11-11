# 08. CI/CD и развёртывание на сервере

> Целевой сервер: общий (на нём живут и другие проекты), 2 vCPU, 2 ГБ RAM, диск 10 ГБ, Ubuntu 24.04.
> Домен: `tip.pavel-and-vera.ru`. Принцип: **собирает GitHub, сервер только скачивает готовые образы**.

## 1. Схема

```mermaid
flowchart LR
    dev[git push в main] --> ci[ci.yml: backend + frontend проверки]
    ci --> build[build: образы tipd и backup]
    build -->|push| ghcr[(GHCR\nghcr.io/owner/repo/tipd:sha-xxxxxxx)]
    build --> deploy[deploy: environment production]
    deploy -->|ssh, пользователь deploy| srv

    subgraph srv[Сервер humo]
      nginx[nginx на хосте\n:80 и :443, TLS, certbot] --> caddy[Caddy в docker\n127.0.0.1:8080, HTTP]
      caddy --> tipd[tipd]
      tipd --> pg[(Postgres)]
      tipd --> redis[(Redis)]
      prom[Prometheus + node_exporter + backup]
    end
    ghcr -->|docker pull| srv
    inet((интернет)) --> nginx
```

* **nginx на хосте** — единственная точка входа для сайта: TLS (certbot, webroot), редирект 80 → 443, HSTS, проксирование на Caddy.
  Его конфиг — `deploy/nginx/tip.conf` (ставится один раз скриптом `bootstrap-server.sh`).
* **Caddy в docker** слушает только `127.0.0.1:8080` по HTTP (`deploy/Caddyfile.edge`, наложение `deploy/docker-compose.server.yml`).
  Наружу стек не публикует **ни одного** другого порта.
* **Клиентский адрес.** nginx *перезаписывает* `X-Forwarded-For` адресом клиента, Caddy доверяет заголовку только от приватных
  адресов (`trusted_proxies`), `tipd` читает цепочку справа налево и берёт первый адрес, не принадлежащий нашей цепочке
  (`clientIP` в `backend/internal/handler/http/middleware.go`, тест `clientip_test.go`). Раньше приложение видело адрес Caddy:
  лимиты по IP и аудит делили один адрес.
* Стек работает как compose-проект **`tip`** в `/opt/tip` (свои сети и тома: `tip_pgdata`, `tip_redisdata`, `tip_uploads`, …).
* По умолчанию поднимаются: `caddy`, `tipd`, `postgres`, `redis`, `prometheus`, `node_exporter`, `backup` (сумма `mem_limit` = 528 МБ).
  `loki`, `vector`, `grafana` вынесены в профиль **`obs`** и по умолчанию выключены (см. раздел 8).

## 2. Что трогает и чего не трогает развёртывание

Не трогаются (другие проекты на этом сервере): проект `tip_tg_bot` (боевая БД на порту 6357, её том и контейнеры), `wedding-eats-*`,
PostgreSQL хоста на `127.0.0.1:5432`, сертификаты и конфиги других доменов в `/etc/letsencrypt`, чужие образы и «висячие» слои docker.

Меняется только:

| Что | Кто и когда |
|---|---|
| пакеты `nginx` (и `certbot`, если нет) | `bootstrap-server.sh`, один раз, root |
| пользователь `deploy`, каталог `/opt/tip`, `/opt/tip/prod.env` | `bootstrap-server.sh`, один раз |
| `/etc/nginx/sites-available/tip.conf` + ссылка в `sites-enabled`, сертификат для `tip.pavel-and-vera.ru` | `bootstrap-server.sh` (повторно: `--nginx-only`) |
| контейнеры, тома и образы проекта `tip` | `deploy.sh` при каждом релизе, пользователь `deploy` |

## 3. Как проходит релиз

1. Push в `main` (или ручной запуск, см. раздел 5) запускает `cd.yml`.
2. **ci**: те же проверки, что и в `ci.yml` (сборка, vet, golangci-lint, `go test -race` с Postgres и Redis, govulncheck; typecheck, lint, тесты и сборка фронтенда).
   Без зелёных проверок дальше ничего не идёт.
3. **build**: `docker buildx` собирает `tipd` (Dockerfile из `deploy/Dockerfile`, фронтенд внутри) и `backup`, пушит в GHCR с тегами
   `sha-<7 символов коммита>` и `latest`. Платформа `linux/amd64`, кэш — GitHub Actions cache.
4. **deploy** (environment `production`, один деплой одновременно): копирует в `/opt/tip` compose-файлы, Caddyfile, конфиги Prometheus/Grafana/nginx и
   скрипты (`prod.env` остаётся на сервере), затем по ssh запускает `scripts/deploy.sh <тег>`.
5. `deploy.sh`:
   * логин в GHCR токеном задания (передаётся через stdin ssh, на сервере не сохраняется — `docker logout` при выходе);
   * `compose pull` новых образов; подъём Postgres и Redis; **миграции новым образом** (`tipd migrate`) — при ошибке выкладка прерывается, работающая версия не тронута;
   * `compose up -d`, ожидание `/readyz` (внутри контейнера и через Caddy) до 90 секунд;
   * при неудаче — **автоматический откат** на предыдущий тег (ненулевой код выхода, задание красное, тег записан в `/opt/tip/.failed_tag`);
   * при успехе — удаляет собственные образы старше двух последних тегов (текущий и предыдущий остаются для отката), пишет сводку.
   Повторный запуск безопасен.

Состояние на сервере: `/opt/tip/.current_tag`, `.previous_tag`, `.image_base`.

> **Миграции и откат.** Откат возвращает только образы, **миграции назад не откатываются**. Каждая миграция должна оставаться совместимой
> с предыдущей версией приложения (сначала добавляем, потом, отдельным релизом, удаляем).

## 4. Что ввести в GitHub

Репозиторий → **Settings**. Значения в таблицах — точные имена.

### 4.1. Environment `production`

**Settings → Environments → New environment → `production`**. Дальше все секреты и переменные из таблиц ниже создаются **внутри этого environment**
(так они доступны только заданию деплоя).

* **Required reviewers** — добавьте себя: каждый деплой будет ждать вашего подтверждения (кнопка Approve в запуске).
  Для приватного репозитория на бесплатном тарифе защитные правила environment недоступны: в этом случае деплой на push в `main` идёт сразу.
  Если так нельзя, удалите блок `push:` из `cd.yml`, оставив `workflow_dispatch` (ручной запуск).

### 4.2. Variables (Environment `production` → Environment variables)

| Имя | Значение |
|---|---|
| `DEPLOY_HOST` | `tip.pavel-and-vera.ru` |
| `DEPLOY_USER` | `deploy` (можно не создавать, это значение по умолчанию) |
| `DEPLOY_PORT` | `22` (можно не создавать) |

### 4.3. Secrets (Environment `production` → Environment secrets)

| Имя | Значение |
|---|---|
| `DEPLOY_SSH_KEY` | **приватный** ключ ed25519 целиком, с первой строкой `-----BEGIN OPENSSH PRIVATE KEY-----` и последней `-----END OPENSSH PRIVATE KEY-----` |
| `DEPLOY_KNOWN_HOSTS` | строка(и) с ключом сервера: `ssh-keyscan -t ed25519 tip.pavel-and-vera.ru` (вставьте вывод целиком). **Сверьте отпечаток** с серверным: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` на сервере |

`GITHUB_TOKEN` создавать не нужно: он выдаётся автоматически и используется для публикации образов и скачивания их на сервере.
Никаких паролей и PAT нигде не хранится.

Пара ключей создаётся локально (приватная часть остаётся только у вас и в секрете GitHub, в репозиторий не попадает):
`ssh-keygen -t ed25519 -N "" -C tip-github-actions-deploy -f tip_deploy` → `tip_deploy` (приватный) идёт в `DEPLOY_SSH_KEY`,
`tip_deploy.pub` отдаётся скрипту подготовки сервера (раздел 6).

### 4.4. Пакеты GHCR

После первой публикации образов: профиль GitHub → **Packages** → `tip_website/tipd` (и `backup`) → **Package settings**:

* убедитесь, что пакет **связан с репозиторием** (Connect repository / «Manage Actions access» содержит этот репозиторий с ролью Read или Write).
  Образы собираются с меткой `org.opencontainers.image.source`, поэтому связь обычно появляется сама;
* видимость можно оставить **private**: сервер скачивает образы токеном задания.

### 4.5. Защита ветки `main`

**Settings → Branches → Add rule → `main`**: Require a pull request before merging; Require status checks to pass
(`backend`, `frontend`); Do not allow force pushes; Do not allow deletions.

## 5. Первый деплой и повседневная работа

1. Подготовьте сервер (раздел 6), создайте environment, переменные и секреты (раздел 4).
2. **Actions → cd → Run workflow** (ветка `main`, поле `ref` пустое). Если включены reviewers — подтвердите деплой.
3. Откройте `https://tip.pavel-and-vera.ru`. Пароль первого администратора (логин `admin`) читается на сервере:
   `grep BOOTSTRAP_ADMIN_PASSWORD /opt/tip/prod.env`; смена пароля при первом входе принудительная.
4. Дальше: слияние в `main` → деплой. Задеплоить другой коммит или тег: **Run workflow** с полем `ref`.

**Где смотреть логи.**

* Выкладка: Actions → запуск `cd` → задания `ci`, `build`, `deploy` (шаг *Deploy* показывает вывод `deploy.sh`).
* Приложение: на сервере под пользователем `deploy`:
  `docker compose -p tip -f /opt/tip/docker-compose.prod.yml -f /opt/tip/docker-compose.server.yml --env-file /opt/tip/prod.env logs --tail 100 tipd`.
* nginx: `/var/log/nginx/{access,error}.log`; сертификаты: `certbot certificates`.

## 6. Подготовка сервера (делает root один раз)

Скрипт ставит nginx и certbot (если их нет), создаёт пользователя `deploy`, `/opt/tip`, генерирует секреты **на сервере** (в чат и логи они не попадают),
ставит конфиг nginx только для нашего домена и получает сертификат только для него. Он не открывает другие порты, не меняет swap/ядро и не задаёт вопросов.

```sh
# с машины, где лежит репозиторий и публичный ключ tip_deploy.pub
scp -r deploy root@tip.pavel-and-vera.ru:/root/tip-bootstrap
scp tip_deploy.pub root@tip.pavel-and-vera.ru:/root/tip-bootstrap/deploy.pub

# 1) только показать, что будет сделано
ssh root@tip.pavel-and-vera.ru 'bash /root/tip-bootstrap/scripts/bootstrap-server.sh --dry-run \
  --domain tip.pavel-and-vera.ru --email ВАШ_EMAIL --expect-hostname humo --deploy-key-file /root/tip-bootstrap/deploy.pub'

# 2) боевой запуск; сначала с тестовым сертификатом Let's Encrypt (не упираться в лимиты при ошибке DNS/80 порта)
ssh root@tip.pavel-and-vera.ru 'bash /root/tip-bootstrap/scripts/bootstrap-server.sh --staging \
  --domain tip.pavel-and-vera.ru --email ВАШ_EMAIL --expect-hostname humo --deploy-key-file /root/tip-bootstrap/deploy.pub'

# 3) настоящий сертификат (тот же скрипт без --staging; --force разрешает уже существующий /opt/tip, prod.env не перезаписывается)
ssh root@tip.pavel-and-vera.ru 'bash /root/tip-bootstrap/scripts/bootstrap-server.sh --force \
  --domain tip.pavel-and-vera.ru --email ВАШ_EMAIL --expect-hostname humo --deploy-key-file /root/tip-bootstrap/deploy.pub'
```

Требования: DNS `tip.pavel-and-vera.ru` указывает на сервер, порты 80 и 443 свободны (или заняты nginx), на сервере есть docker и compose-плагин.
Скрипт отказывается работать, если имя хоста не совпало с `--expect-hostname`, или порт 80/443 занят чем-то кроме nginx.

Если позже изменится `deploy/nginx/tip.conf`, деплой это увидит (предупреждение в конце `deploy.sh`), а применяет root:
`bash scripts/bootstrap-server.sh --nginx-only --domain … --email … --expect-hostname humo` (с `nginx -t` и откатом предыдущего файла при ошибке).

Пользователь `deploy` состоит в группе `docker`, а это фактически права root на хосте. Поэтому его ключ ограничен (`no-pty`, без проброса портов и агента),
пароля у пользователя нет, а ключ живёт только в секретах GitHub-environment.

Заметка (скрипт этого не делает): на сервере с 2 ГБ имеет смысл включить zram (`apt install zram-tools`) и `vm.swappiness=10`.

## 7. Откат

* **Автоматический**: если новая версия не стала здоровой за 90 секунд, `deploy.sh` сам возвращает предыдущий тег (задание красное).
* **Ручной** (сервер, пользователь `deploy`): `cd /opt/tip && scripts/rollback.sh` — на предыдущий тег, или `scripts/rollback.sh sha-abc1234` — на конкретный,
  если его образ ещё на сервере (хранятся текущий и предыдущий).
* **Старый коммит, которого нет на сервере**: Actions → cd → Run workflow с `ref` этого коммита.

## 8. Наблюдаемость на общем сервере

Prometheus и node_exporter работают всегда. Loki, Vector и Grafana (около 500 МБ лимитов) включаются вручную, пока нужно разобраться в проблеме:

```sh
# в /opt/tip/prod.env: LOKI_URL=http://loki:3100 ; GRAFANA_DOMAIN, GRAFANA_ADMIN_PASSWORD, GRAFANA_URL (если нужна ссылка в меню админа)
docker compose -p tip -f docker-compose.prod.yml -f docker-compose.server.yml --env-file prod.env --profile obs up -d
docker compose -p tip … --profile obs stop loki vector grafana     # выключить
```

Grafana в серверном режиме наружу не проксируется (Caddyfile.edge её не знает): заходить через ssh-туннель к контейнеру или добавить отдельный server-блок nginx позже.

## 9. Отложено: проброс боевой БД через nginx (`stream`)

Порт `6357` сейчас публикует контейнер `tip_tg_bot-db-1` другого проекта напрямую в интернет. Идея шлюза — убрать публикацию из того compose-проекта и
отдавать порт через nginx `stream` (`limit_conn`, при постоянных адресах операторов — `allow/deny`). Это **требует пересоздания контейнера БД чужого проекта**
(короткий простой, том сохраняется), поэтому в CI/CD сейчас не реализовано и ничего на сервере с этим не сделано. План на потом:

1. В `/root/tip_tg_bot/docker-compose.yaml` заменить публикацию `6357:5432` на `127.0.0.1:6358:5432`, пересоздать только сервис `db` (`up -d db`), проверить клиента.
2. В nginx добавить блок `stream { server { listen 6357; proxy_pass 127.0.0.1:6358; … } }` (модуль `ngx_stream_core_module` входит в пакет Ubuntu).
3. Postgres увидит адрес nginx вместо адреса клиента (PROXY protocol он не поддерживает): ограничения по IP делаются в nginx, а не в `pg_hba.conf`.

## 10. Что проверено локально и что нет

Проверено на машине разработчика: `actionlint` по `ci.yml` и `cd.yml`; `shellcheck` по всем скриптам; `nginx -t` на официальном образе;
`docker compose config` для режимов «по умолчанию» и `--profile obs`, с наложением сервера и без; **репетиция** `deploy.sh` и `rollback.sh` в проекте `tip-rehearsal`
(первый деплой, обновление, прерывание из-за ошибки миграции, автоматический откат при нездоровом релизе, ручной откат, очистка образов, повторный запуск того же тега);
цепочка nginx → Caddy → tipd (заголовки, единственный HSTS, перезапись `X-Forwarded-For`); `bootstrap-server.sh` в контейнере Ubuntu 24.04 (сухой запуск и реальный
с заглушками certbot и systemd: пользователь, ключ, `prod.env` режима 600, nginx -t, повторный запуск).

**Не проверено без настоящих сервера и GitHub:** выпуск сертификата certbot и продление; вход docker в GHCR токеном задания на сервере; реальное ssh-подключение
с закреплённым ключом; кнопки и правила в интерфейсе GitHub (environment, защита ветки, видимость пакетов); кэш `type=gha`; WebSocket через nginx на живом сервере
(в конфиге заданы `Upgrade`/`Connection`, длинные таймауты, `proxy_buffering off`, но сквозная проверка рабочей сессии не выполнялась); работа на реальных 2 ГБ под нагрузкой.
