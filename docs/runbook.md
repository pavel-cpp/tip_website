# Ранбук TIP Web

Операционная инструкция для администратора сервера (2 vCPU, 2 ГБ RAM, HDD 10 ГБ). Архитектура и бюджеты ресурсов — в
[02-architecture.md](02-architecture.md) (разделы 8–9) и [05-observability.md](05-observability.md). Все файлы развёртывания лежат в `deploy/`.

Во всех командах ниже предполагается, что вы в каталоге репозитория на сервере и задали алиас (проект compose называется `tip`, тома — `tip_pgdata`, `tip_uploads` и т. д.):

```bash
alias dc='docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env'
```

## 1. Первое развёртывание

1. **Сервер.** Минимальный Linux (Debian/Ubuntu Server), Docker Engine + compose plugin. Файрвол: наружу открыты только `80/tcp`, `443/tcp`, `443/udp` и SSH. DNS-запись `DOMAIN` указывает на сервер (нужны Caddy для выпуска сертификатов).
2. **Память и своп** (см. раздел 2): включите zram, понизьте `vm.swappiness`. Файл подкачки на HDD не создавайте.
3. **Код и образы.**
   ```bash
   git clone <репозиторий> /opt/tip && cd /opt/tip
   cp deploy/prod.env.example deploy/prod.env && chmod 600 deploy/prod.env
   ```
4. **Секреты** (`deploy/prod.env`): сгенерируйте значения `openssl rand -hex 32` для `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PASSWORD_PEPPER` (все три разные), `POSTGRES_PASSWORD`, `REDIS_PASSWORD` (только hex: пароли встраиваются в URL), `GRAFANA_ADMIN_PASSWORD`.
   Заполните `DOMAIN`, `GRAFANA_URL` (`https://DOMAIN/grafana/`), `ACME_EMAIL`, `ALLOWED_ORIGINS`, `BOOTSTRAP_ADMIN_*`.
   Файл `prod.env` не коммитится; его копию храните у владельца отдельно от сервера (в менеджере паролей).
5. **Проверка конфигурации и запуск.**
   ```bash
   dc config -q          # молчит, если всё в порядке
   dc build              # собирает tipd и backup (или: dc pull, если образы в реестре)
   dc up -d
   dc ps                 # все сервисы должны стать healthy
   ```
6. **Первый вход.** Откройте `https://DOMAIN`, войдите под `BOOTSTRAP_ADMIN_LOGIN`, смените пароль, затем удалите `BOOTSTRAP_ADMIN_*` из `prod.env` и выполните `dc up -d tipd`.
7. **Наблюдаемость.** Откройте `https://DOMAIN/grafana/` (вход Grafana), папка `TIP`: дашборды «TIP Overview», «TIP Realtime», «TIP Logs», «TIP Resources» (процессор, память и диск машины и каждого сервиса). Алерты: Alerting -> Alert rules (папка `TIP`).
   Проверьте доставку: Alerting -> Contact points -> `tip-admins` -> Test. Для e-mail задайте `GF_SMTP_*` и `ALERT_EMAIL_TO`, для webhook — `ALERT_WEBHOOK_URL` (затем `dc up -d grafana`). Telegram недоступен.
8. **Внешний пинг.** Настройте любой доступный из РФ сервис мониторинга или cron на своём ПК, который опрашивает `https://DOMAIN/healthz`: если упал весь сервер, Grafana вместе с ним недоступна.
9. **Бэкапы.** Выполните первый бэкап вручную и проверьте результат (раздел 5), настройте off-site (раздел 5.3).

## 2. Память: zram и swappiness

На сервере 2 ГБ RAM, контейнеры занимают ≈ 1 ГБ (`mem_limit` у каждого). Своп на HDD губителен, поэтому вместо файла подкачки используется **zram** (сжатая память) как страховка:

```bash
apt install zram-tools
# /etc/default/zramswap
ALGO=zstd
PERCENT=25          # ≈ 512 МБ
PRIORITY=100
systemctl restart zramswap

# /etc/sysctl.d/99-tip.conf
vm.swappiness=10
vm.overcommit_memory=1      # требуется Redis для безопасного fork при AOF rewrite
sysctl --system
```

Проверка: `free -m`, `swapon --show` (только `/dev/zram0`). Все контейнеры запущены с `memswap_limit = mem_limit`, то есть внутрь контейнеров своп не используется. При нехватке памяти первыми завершаются Grafana/Loki/Prometheus/Vector (`oom_score_adj` > 0), а `tipd`, Postgres и Redis защищены (`oom_score_adj` < 0). Узнать, был ли контейнер убит по памяти:

```bash
docker inspect -f '{{.Name}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' $(docker ps -aq)
```

## 3. Обновление

1. Сделайте бэкап перед релизом: `dc exec backup /usr/local/bin/backup.sh` (должен завершиться «done»).
2. Обновите код и образы:
   ```bash
   git pull
   dc build tipd          # либо: TIPD_IMAGE=<новый тег> в prod.env и dc pull tipd
   dc up -d
   ```
3. Миграции применяются при старте `tipd` (`AUTO_MIGRATE=true`, под advisory-lock). Следите за журналом: `dc logs -f tipd`.
4. Проверьте `dc ps` (tipd healthy), `https://DOMAIN/readyz`, графики 5xx в «TIP Overview» в течение 10–15 минут.
5. Конфиги наблюдаемости (`deploy/prometheus`, `deploy/loki`, `deploy/vector`, `deploy/grafana`) подхватываются перезапуском соответствующего сервиса: `dc up -d --force-recreate loki` и т. п. Дашборды Grafana перечитываются автоматически раз в минуту.
6. Старые образы удаляйте, чтобы не копились на диске: `docker image prune -f`.

## 4. Откат

1. **Только код** (миграции не менялись или обратно совместимы): в `prod.env` укажите предыдущий тег `TIPD_IMAGE`, затем `dc up -d tipd`.
2. **Миграция БД несовместима с прежней версией:** остановите приложение `dc stop tipd`, восстановите БД из бэкапа, сделанного перед релизом (раздел 5.2), верните предыдущий тег образа и `dc up -d tipd`. Данные, записанные после бэкапа, будут потеряны — предупредите операторов.
3. После отката проверьте `readyz` и журнал `tipd`.

## 5. Бэкапы и восстановление

### 5.1 Что и как

Контейнер `backup` по cron (`BACKUP_CRON`, по умолчанию 01:30 UTC) делает:

* `pg_dump -Fc` -> том `tip_backups`, файл `db-YYYYMMDD.dump`; хранится `BACKUP_KEEP` (3) последних;
* один «катящийся» снимок `uploads.tar` (картинки неизменяемы, копия одна);
* перед записью проверяет свободное место (нужно: размер `uploads` + оценка дампа + `BACKUP_MIN_FREE_MB`); при нехватке бэкап пропускается с ошибкой в журнале, а метрика устаревает и срабатывает алерт «Backup older than 36 hours»;
* выгрузку off-site через `rclone` (если задан `BACKUP_REMOTE`), только в `crypt`-remote — в бэкапах персональные данные; в обычный remote скрипт выгружать откажется;
* метрики `backup_last_success_timestamp{target="local|offsite"}` в `/backups/metrics/backup.prom` (читает `node_exporter`, textfile collector).

Redis **не бэкапится** (раздел 7). Запустить бэкап вручную и посмотреть список: `dc exec backup /usr/local/bin/backup.sh` и `dc exec backup restore.sh list`. Журнал: `dc logs backup`.

### 5.2 Восстановление (локальные копии)

```bash
dc stop tipd                                   # чтобы никто не писал во время восстановления
dc exec backup restore.sh list                 # что есть
dc exec backup restore.sh db                   # новейший дамп; или: restore.sh db /backups/db-20261105.dump
# скрипт спросит имя БД (по умолчанию tip) для подтверждения
```

Картинки: контейнер `backup` монтирует `uploads` только для чтения, поэтому восстановление запускается отдельным контейнером с записью:

```bash
docker run --rm -it -v tip_uploads:/data -v tip_backups:/backups \
  --entrypoint /usr/local/bin/restore.sh tip/backup:local uploads
# подтверждение: слово «uploads»
dc up -d tipd
```

### 5.3 Off-site (rclone crypt)

Настройка один раз, на вашем компьютере или на сервере (`rclone config`):

1. Создайте базовый remote (S3-совместимое облако — Yandex Object Storage, VK Cloud, Selectel; либо SFTP).
2. Создайте поверх него remote типа `crypt` (например, `tipcrypt:`), задайте пароль и salt шифрования.
3. Файл `rclone.conf` положите на сервер вне репозитория (например, `/opt/tip/secrets/rclone.conf`, `chmod 600`), путь укажите в `RCLONE_CONFIG_FILE`, имя remote — в `BACKUP_REMOTE` (`tipcrypt:tip`), затем `dc up -d backup`.
4. **Копию `rclone.conf` (в первую очередь пароли crypt) храните у владельца отдельно от сервера.** Без неё внешние бэкапы расшифровать нельзя.
5. На стороне облака настройте версионирование/lifecycle (≈ 14 копий): на сервере для этого нет места.

Восстановление с нуля из off-site: поднимите стек (раздел 1, без запуска `tipd`), положите `rclone.conf`, затем

```bash
dc run --rm backup restore.sh fetch            # скачивает новейшие db-*.dump и uploads.tar в /backups/offsite
dc run --rm backup restore.sh db /backups/offsite/db-YYYYMMDD.dump
docker run --rm -it -v tip_uploads:/data -v tip_backups:/backups \
  --entrypoint /usr/local/bin/restore.sh tip/backup:local uploads /backups/offsite/uploads.tar
dc up -d
```

### 5.4 Учения по восстановлению (restore drill)

Проводятся перед запуском в эксплуатацию и далее раз в квартал, желательно на отдельной машине или с другим `name`/портами. Порядок: бэкап -> восстановление БД и картинок в чистый стек -> вход в приложение, открыть проект с картинкой и таблицей участников -> сверить количество строк (`select count(*) from participants`) и несколько картинок. Для off-site повторить с шагом `fetch`. Результаты заносить сюда:

| Дата | Кто | Источник (local / off-site) | Время восстановления | Результат / замечания |
|---|---|---|---|---|
| _не проводились_ | | | | |

## 6. Диск заполняется

Алерт «Disk free below 1.5 GB» или `df` > 85 %. Бюджет — [05-observability.md](05-observability.md), 6.1.

1. Что занимает место:
   ```bash
   df -h /
   docker system df
   du -sh /var/lib/docker/volumes/tip_*   # по томам
   ```
2. По убыванию безопасности действий:
   * `docker image prune -f` и `docker builder prune -f` — старые образы и кэш сборки (первые кандидаты);
   * `journalctl --vacuum-size=100M` и `apt clean` — журнал и кэш ОС;
   * логи и метрики: уменьшите `OBS_RETENTION_DAYS` (раздел 10), диск освободится после очередного прохода компактора Loki (до нескольких часов);
   * `tip_backups`: проверьте, что дампов не больше `BACKUP_KEEP`; лишние удалите `dc exec backup sh -c 'ls /backups'`;
   * `tip_uploads`: потолок `UPLOADS_MAX_TOTAL_MB` (при превышении `tipd` отвечает `507 DISK_LOW`); удалите ненужные завершённые проекты через интерфейс (файл освобождается сразу);
   * аудит: `AUDIT_RETENTION_DAYS`/`AUDIT_MAX_ROWS` уменьшают размер таблицы после ночной очистки.
3. Не удаляйте вручную содержимое `tip_pgdata`, `tip_redisdata` и `tip_uploads`.
4. Если свободно < `MIN_FREE_DISK_MB`, загрузки картинок отклоняются (`507`), остальное работает. Бэкап при нехватке места пропускается — после освобождения места запустите его вручную.

## 7. Потеря данных Redis

Redis хранит только токены (refresh allow-list, отзывы, чёрный список). Он **не бэкапится**; в Postgres токенов нет. `appendonly yes` + `appendfsync everysec` защищают от потери при обычном перезапуске.

Если том `tip_redisdata` потерян или Redis пересоздан с пустыми данными (в том числе `FLUSHALL`):

* все пользователи один раз выходят и входят заново — это нормально и безопасно;
* теряются «сожжённые» refresh-токены, закрытые цепочки и отсечки пользователей: уже использованный (возможно, украденный) refresh снова становится валидным до своего `exp` (≤ 30 дней). Деактивированных пользователей это не спасает — их блокирует проверка `is_active` при обновлении;
* **после инцидента** (особенно при подозрении на компрометацию) смените `JWT_REFRESH_SECRET` (раздел 9);
* пока Redis недоступен: `login`/`refresh`/`logout` отвечают 503; проверка access-токенов зависит от `REDIS_FAIL_MODE` (`open` — чёрный список пропускается с алертом, `closed` — 503). Через 15 минут без Redis refresh невозможен, и все будут разлогинены.

## 8. Типовые проблемы

### 8.1 WebSocket-клиенты отваливаются

1. Дашборд «TIP Realtime»: `tip_ws_connections`, рост `tip_ws_slow_client_disconnects_total`, `tip_log_dropped_total`.
2. Не перезапускался ли `tipd`: `dc ps`, `docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' tip-tipd-1`. OOM -> смотрите RSS на «TIP Overview» (лимит 96 МиБ, `GOMEMLIMIT=80MiB`). Профиль кучи (pprof) доступен только во внутренней сети на `tipd:9090`: `docker run --rm --network tip_internal curlimages/curl -s http://tipd:9090/debug/pprof/heap > heap.pprof`, затем `go tool pprof heap.pprof` на своей машине (в distroless-образе `tipd` нет ни shell, ни curl).
3. Журнал «медленный клиент» (WARN): `{service="tipd"} | json | msg=~".*slow.*"` в Explore -> Loki. Массовые отвалы у одной группы клиентов — проблема их сети или Wi-Fi; у всех сразу — перезапуск `tipd`, Caddy или проблемы Redis/CPU (`node_load1`).
4. Caddy: `dc logs caddy | tail`; таймауты прокси не должны разрывать WS (Caddy проксирует upgrade прозрачно). Проверьте, что перед сервером нет другого прокси с коротким idle-таймаутом.
5. Клиенты автоматически переподключаются; убедитесь, что после реконнекта таблица синхронизируется (клиент перезапрашивает снимок).

### 8.2 Медленные запросы

1. «TIP Overview»: p95 по маршрутам -> какой `route` деградировал. «TIP Logs»: панели «Slow queries» (`| json | dur_ms > 300`) и «Postgres slow statements» (`log_min_duration_statement=300ms`).
2. Пул БД: `tip_db_in_use` близко к 10, растёт `tip_db_wait_count_total` — запросы ждут соединения; ищите долгие транзакции.
3. Активные запросы:
   ```bash
   dc exec postgres psql -U tip -d tip -c "select pid, now()-query_start as dur, state, left(query,120) from pg_stat_activity where state <> 'idle' order by dur desc;"
   ```
4. План: `EXPLAIN (ANALYZE, BUFFERS)` на копии запроса; проверьте индексы ([03-database.md](03-database.md)). Нагрузку от `VACUUM`/checkpoint видно по I/O на HDD (`node_disk_io_time_seconds_total`).
5. Задержки на всех маршрутах сразу — смотрите нехватку CPU/IO хоста и работу фоновых задач (аудит, GC файлов).

### 8.3 Забыт пароль администратора

Из контейнера приложения (учётная запись админа в БД, токены в Redis):

```bash
dc exec tipd /tipd admin reset-password <login>
```

Команда выведет новый временный пароль; передайте его владельцу учётной записи безопасным каналом и попросите сменить при входе. Точные флаги — `dc exec tipd /tipd admin reset-password --help`. Остальным пользователям пароль сбрасывает админ в панели.

## 9. Ротация секретов JWT

`JWT_ACCESS_SECRET` и `JWT_REFRESH_SECRET` — ключи HMAC. Смена мгновенно делает недействительными все выданные токены: **все пользователи будут разлогинены и войдут заново** (потери данных нет; предупредите операторов, лучше в нерабочее время).

1. Сгенерируйте новые значения: `openssl rand -hex 32` (два разных).
2. Измените `JWT_REFRESH_SECRET` (и/или `JWT_ACCESS_SECRET`) в `deploy/prod.env`, сохраните старую версию файла в менеджере паролей до подтверждения.
3. `dc up -d tipd`. Проверьте вход и отсутствие всплеска ошибок.
4. Старые ключи `rt:*`/`bl:*` в Redis безвредны и истекут по TTL. При ротации после инцидента можно дополнительно очистить Redis: `dc exec redis redis-cli FLUSHALL`.

`PASSWORD_PEPPER` так не ротируется: хэш хранит версию pepper, смена выполняется по процедуре перехэширования при входе (см. [02-architecture.md](02-architecture.md)); просто заменить значение нельзя — никто не сможет войти.

## 10. Изменение срока хранения логов и метрик

Один параметр `OBS_RETENTION_DAYS` (3 по умолчанию, допустимо 3–5; при диске 10 ГБ не увеличивайте без замера — [05-observability.md](05-observability.md), 6.1).

1. Измените значение в `deploy/prod.env`.
2. Примените: `dc up -d loki prometheus` (Compose пересоздаст контейнеры с новыми флагами; Loki читает переменную через `-config.expand-env`, Prometheus — через `--storage.tsdb.retention.time`).
3. Проверка: Prometheus `Status -> Runtime & Build Information` показывает retention (во внутренней сети: `docker run --rm --network tip_internal curlimages/curl -s http://prometheus:9090/api/v1/status/flags | grep retention`); для Loki — `dc logs loki | grep -i retention`.
4. При уменьшении срока старые данные физически удаляются не сразу: компактор Loki работает раз в 10 минут с задержкой удаления 2 часа; Prometheus удаляет блоки по мере ротации. Потолок Prometheus — `retention.size=300MB`.
5. Увеличили срок — следите за `df` и объёмом `tip_lokidata` первые 7 суток.

## 11. Прочее

* **Перезапуск сервиса:** `dc restart <service>`; логи: `dc logs --tail=200 -f <service>`; из Grafana: Explore -> Loki, `{service="tipd"} | json | request_id="<ID>"` (ID запроса виден в заголовке ответа и в логах).
* **Если упал Loki или Vector:** `tipd` продолжает работать, логи копятся в Docker json-file (10 МБ на контейнер) и догоняются после восстановления; при долгом простое старые строки теряются.
* **Если RAM не хватает:** временно остановите Grafana (`dc stop grafana`, ≈ 190 МБ) — алерты перестанут работать, поэтому рассчитывайте на внешний пинг и плашку в админ-панели.
* **Остановка всего стека:** `dc down` (тома сохраняются). Команда `dc down -v` **удаляет все данные** — не используйте без бэкапа.
