# 08. CI/CD и развёртывание на сервере

> Целевой сервер: общий (на нём живут и другие проекты), 2 vCPU, 2 ГБ RAM, Ubuntu 24.04.
> Домен: `tip.pavel-and-vera.ru`. Принцип: **собирает GitHub, сервер только скачивает готовые образы**.
> Единственная точка входа — **Caddy в docker**: он сам получает и продлевает сертификат. Ни nginx, ни certbot на хосте не нужны.

## 1. Схема

```mermaid
flowchart LR
    dev[git push в main] --> ci[ci.yml: backend + frontend проверки]
    ci --> build[build: образы tipd и backup]
    build -->|push| ghcr[(GHCR\nghcr.io/owner/repo/tipd:sha-xxxxxxx)]
    build --> deploy[deploy: environment production]
    deploy -->|ssh, пользователь deploy| srv

    subgraph srv[Сервер humo]
      caddy[Caddy в docker\n:80 и :443, TLS сам] --> tipd[tipd]
      tipd --> pg[(Postgres)]
      tipd --> redis[(Redis)]
      prom[Prometheus + node_exporter + backup]
    end
    ghcr -->|docker pull| srv
    inet((интернет)) --> caddy
```

* **Caddy** (контейнер проекта `tip`) публикует `80`, `443` и `443/udp` (HTTP/3), сам выпускает и продлевает сертификат Let's Encrypt для `DOMAIN`
  (данные и ключи — в томе `tip_caddy`, он **переживает деплои и не должен чиститься**), редиректит 80 → 443, добавляет заголовки безопасности (HSTS и др.)
  и проксирует на `tipd`. Конфиг — `deploy/Caddyfile`. Других портов стек наружу не публикует.
* **Клиентский адрес.** Перед Caddy никого нет, поэтому присланный клиентом `X-Forwarded-For` **не доверяется**: Caddy заменяет его адресом, который
  реально видел (`trusted_proxies` не задан намеренно). `tipd` читает цепочку справа налево и берёт первый адрес, не принадлежащий нашей сети
  (`clientIP` в `backend/internal/handler/http/middleware.go`, тест `clientip_test.go`). Проверено репетицией: подделка `6.6.6.6, 7.7.7.7` до приложения не доходит.
  Ограничение: клиенты по IPv6 приходят через docker-proxy и видны как адрес шлюза docker-сети (лимиты по IP для них общие), IPv4 сохраняется.
* Стек работает как compose-проект **`tip`** в `/opt/tip` (свои сети и тома: `tip_pgdata`, `tip_redisdata`, `tip_uploads`, `tip_caddy`, …).
* По умолчанию поднимаются: `caddy`, `tipd`, `postgres`, `redis`, `prometheus`, `node_exporter`, `backup` (сумма `mem_limit` = 528 МБ).
  `loki`, `vector`, `grafana` вынесены в профиль **`obs`** и по умолчанию выключены (см. раздел 8).
* **Docker и `ufw`.** Порты, опубликованные docker, идут в обход правил `ufw`. Пока наружу смотрят только 80/443 у Caddy и порт `6357` старой базы,
  это не проблема, но любой новый `ports:` без `127.0.0.1:` будет открыт всему интернету независимо от `ufw`.

## 2. Что трогает и чего не трогает развёртывание

Не трогаются (другие проекты на этом сервере): проект `tip_tg_bot` / `old_tip_database` (боевая БД на порту 6357, её том и контейнеры), `wedding-eats-*`,
PostgreSQL хоста на `127.0.0.1:5432`, чужие образы и «висячие» слои docker.

Меняется только:

| Что | Кто и когда |
|---|---|
| пользователь `deploy`, каталог `/opt/tip`, `/opt/tip/prod.env` | `bootstrap-server.sh`, один раз, root |
| контейнеры, тома и образы проекта `tip` | `deploy.sh` при каждом релизе, пользователь `deploy` |

## 3. Как проходит релиз

1. Push в `main` (или ручной запуск, см. раздел 5) запускает `cd.yml`.
2. **ci**: те же проверки, что и в `ci.yml` (сборка, vet, golangci-lint, `go test -race` с Postgres и Redis, govulncheck; typecheck, lint, тесты и сборка фронтенда).
   Без зелёных проверок дальше ничего не идёт.
3. **build**: `docker buildx` собирает `tipd` (Dockerfile из `deploy/Dockerfile`, фронтенд внутри) и `backup`, пушит в GHCR с тегами
   `sha-<7 символов коммита>` и `latest`. Платформа `linux/amd64`, кэш — GitHub Actions cache.
4. **deploy** (environment `production`, один деплой одновременно): копирует в `/opt/tip` compose-файл, `Caddyfile`, `caddy.d/`, конфиги Prometheus/Grafana и
   скрипты (`prod.env` остаётся на сервере), затем по ssh запускает `scripts/deploy.sh <тег>`.
5. `deploy.sh`:
   * логин в GHCR токеном задания (передаётся через stdin ssh, на сервере не сохраняется — `docker logout` при выходе);
   * `compose pull` новых образов; подъём Postgres и Redis; **миграции новым образом** (`tipd migrate`) — при ошибке выкладка прерывается, работающая версия не тронута;
   * `compose up -d --no-build` (на сервере ничего не собирается), ожидание `/readyz` (внутри контейнера и через Caddy) до 90 секунд. Проверка через Caddy идёт по
     внутреннему HTTP-адресу `127.0.0.1:8081` **внутри контейнера** (наружу не публикуется), поэтому деплой оценивается по приложению и прокси, а не по выпуску сертификата;
   * при неудаче — **автоматический откат** на предыдущий тег (ненулевой код выхода, задание красное, тег записан в `/opt/tip/.failed_tag`);
   * при успехе — удаляет собственные образы старше двух последних тегов (текущий и предыдущий остаются для отката), печатает сводку и **справочно** проверяет,
     отвечает ли `https://DOMAIN` доверенным сертификатом (сообщение, но не ошибка: сразу после первого запуска Caddy ещё может получать сертификат).
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

**Сертификат при первом запуске.** Caddy получает сертификат при первом запросе к домену; для этого DNS `DOMAIN` должен указывать на сервер, а порты 80 и 443 быть
доступны из интернета. Если хотите сначала проверить цепочку без лимитов Let's Encrypt, добавьте в `/opt/tip/prod.env` строку
`ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory`, запустите деплой (браузер покажет предупреждение о ненадёжном сертификате, это нормально),
затем **удалите строку** и запустите деплой снова: Caddy пересоздастся и получит настоящий сертификат. Адрес почты (`ACME_EMAIL`) необязателен: пустое значение
значит регистрацию без почты (уведомлений о сроке не будет, продление идёт само).

**Где смотреть логи.**

* Выкладка: Actions → запуск `cd` → задания `ci`, `build`, `deploy` (шаг *Deploy* показывает вывод `deploy.sh`).
* Приложение и сертификат: на сервере под пользователем `deploy`:
  `docker compose -p tip -f /opt/tip/docker-compose.prod.yml --env-file /opt/tip/prod.env logs --tail 100 tipd` (или `caddy` для выпуска сертификата).

## 6. Подготовка сервера (делает root один раз)

Скрипт создаёт пользователя `deploy`, каталог `/opt/tip` и `prod.env` с секретами, сгенерированными **на сервере** (в чат и логи они не попадают).
Он ничего не ставит на хост, не открывает порты, не меняет swap/ядро и не задаёт вопросов.

```sh
# с машины, где лежит репозиторий и публичный ключ tip_deploy.pub
scp -r deploy root@tip.pavel-and-vera.ru:/root/tip-bootstrap
scp tip_deploy.pub root@tip.pavel-and-vera.ru:/root/tip-bootstrap/deploy.pub

# 1) только показать, что будет сделано
ssh root@tip.pavel-and-vera.ru 'bash /root/tip-bootstrap/scripts/bootstrap-server.sh --dry-run \
  --domain tip.pavel-and-vera.ru --expect-hostname humo --deploy-key-file /root/tip-bootstrap/deploy.pub'

# 2) боевой запуск (--force разрешает уже существующий /opt/tip; существующий prod.env не перезаписывается)
ssh root@tip.pavel-and-vera.ru 'bash /root/tip-bootstrap/scripts/bootstrap-server.sh --force \
  --domain tip.pavel-and-vera.ru --expect-hostname humo --deploy-key-file /root/tip-bootstrap/deploy.pub'
```

Требования: DNS `tip.pavel-and-vera.ru` указывает на сервер, на сервере есть docker и compose-плагин, порты 80 и 443 не заняты чужим процессом
(**nginx и certbot прежней схемы нужно остановить и убрать до запуска**: скрипт отказывается работать, если 80/443 держит не docker).
Скрипт также отказывается работать, если имя хоста не совпало с `--expect-hostname`.

Совместимость с прежним `prod.env`: файл, созданный предыдущей версией скрипта (с `EDGE_PORT=8080` и пустым `ACME_EMAIL`), менять не нужно, лишние ключи игнорируются.

Пользователь `deploy` состоит в группе `docker`, а это фактически права root на хосте. Поэтому его ключ ограничен (`no-pty`, без проброса портов и агента),
пароля у пользователя нет, а ключ живёт только в секретах GitHub-environment.

Заметка (скрипт этого не делает): на сервере с 2 ГБ имеет смысл включить zram (`apt install zram-tools`) и `vm.swappiness=10`.
Если `ufw` включён, 80/tcp и 443/tcp должны быть разрешены (docker в любом случае публикует порты мимо `ufw`).

## 7. Откат

* **Автоматический**: если новая версия не стала здоровой за 90 секунд, `deploy.sh` сам возвращает предыдущий тег (задание красное).
* **Ручной** (сервер, пользователь `deploy`): `cd /opt/tip && scripts/rollback.sh` — на предыдущий тег, или `scripts/rollback.sh sha-abc1234` — на конкретный,
  если его образ ещё на сервере (хранятся текущий и предыдущий).
* **Старый коммит, которого нет на сервере**: Actions → cd → Run workflow с `ref` этого коммита.

Проверка Caddy на здоровье `tipd` идёт каждые 3 секунды: после замены контейнера публичный сайт возвращается к 200 сразу, а не через длинный интервал.

## 8. Наблюдаемость на общем сервере

Prometheus и node_exporter работают всегда. Loki, Vector и Grafana (около 500 МБ лимитов) включаются вручную, пока нужно разобраться в проблеме:

```sh
# в /opt/tip/prod.env: LOKI_URL=http://loki:3100 ; GRAFANA_ADMIN_PASSWORD ; для публичного адреса Grafana ещё GRAFANA_DOMAIN,
#   GRAFANA_BASIC_AUTH_USER и GRAFANA_BASIC_AUTH_HASH (хеш: docker run --rm caddy:2.9-alpine caddy hash-password)
cp caddy.d/grafana.caddy.example caddy.d/grafana.caddy       # подключает отдельный сайт Grafana (нужен DNS для GRAFANA_DOMAIN)
docker compose -p tip -f docker-compose.prod.yml --env-file prod.env --profile obs up -d
docker compose -p tip -f docker-compose.prod.yml --env-file prod.env --profile obs stop loki vector grafana     # выключить
```

Без `caddy.d/grafana.caddy` Grafana наружу не проксируется: заходить через ssh-туннель к контейнеру. Файл `caddy.d/grafana.caddy`, созданный на сервере,
деплой не перезаписывает и не удаляет.

## 9. Старая боевая БД на порту 6357

Порт `6357` публикует контейнер `old_tip_database-db-1` другого compose-проекта (`/root/old_tip_database`) прямо в интернет: старое приложение подключается к нему напрямую.
Caddy проксирует только HTTP(S), поэтому отдельного шлюза для этого порта в схеме нет и CI/CD его не касается. Ограничить доступ можно либо правилами `iptables`
в цепочке `DOCKER-USER` (разрешить только постоянные адреса операторов; `ufw` порты docker не фильтрует), либо перейти на SSH-туннель. Решение отложено.

## 10. Что проверено локально и что нет

Проверено на машине разработчика: `actionlint` по `ci.yml` и `cd.yml`; `shellcheck` по всем скриптам; `docker compose config` для режимов «по умолчанию» и `--profile obs`,
в том числе с `prod.env` в формате прежней версии скрипта и из набора файлов, который копирует `cd.yml` (без каталогов сборки); `caddy validate` с пустым и заполненным
`ACME_EMAIL`/`ACME_CA`, с подключённым `caddy.d/grafana.caddy` и без файлов в `caddy.d`; **репетиция** `deploy.sh` и `rollback.sh` в проекте `tip-rehearsal`
(первый деплой, обновление, автоматический откат при нездоровом релизе, прерывание из-за ошибки миграции, ручной откат; сертификат Caddy сохранился между деплоями;
наружу опубликованы только порты Caddy; публичный сайт отвечает 200 сразу после отката; подделанный `X-Forwarded-For` не доходит до приложения). В репетиции вместо
Let's Encrypt использовалась встроенная CA Caddy для `localhost`, образы шли из локального реестра, порты были 18080/18443.

**Не проверено без настоящих сервера и GitHub:** выпуск и продление сертификата Let's Encrypt (в том числе переход со staging на боевой CA); вход docker в GHCR токеном
задания на сервере; реальное ssh-подключение с закреплённым ключом; кнопки и правила в интерфейсе GitHub (environment, защита ветки, видимость пакетов);
кэш `type=gha`; WebSocket через Caddy на живом сервере; поведение клиентских адресов IPv6 за docker-proxy; работа на реальных 2 ГБ под нагрузкой.
