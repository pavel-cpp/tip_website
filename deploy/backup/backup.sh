#!/bin/sh
# Nightly backup.
#   1. free-space check (skip with a non-zero exit instead of filling the disk)
#   2. pg_dump -Fc -> $BACKUP_DIR/db-YYYYMMDD.dump, keep the newest BACKUP_KEEP
#   3. one rolling snapshot of $DATA_DIR/uploads -> $BACKUP_DIR/uploads.tar
#   4. optional off-site upload through an rclone crypt remote
#   5. Prometheus textfile metrics for node_exporter
# Redis is intentionally not backed up (docs/05-observability.md section 5).
#
# Environment: PG* (libpq), BACKUP_DIR, DATA_DIR, BACKUP_KEEP,
# BACKUP_MIN_FREE_MB, BACKUP_REMOTE, RCLONE_CONFIG, BACKUP_TODAY (tests).
# shellcheck disable=SC2012  # file names are generated here (db-YYYYMMDD.dump)
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
DATA_DIR=${DATA_DIR:-/data}
KEEP=${BACKUP_KEEP:-3}
MIN_FREE_MB=${BACKUP_MIN_FREE_MB:-1500}
REMOTE=${BACKUP_REMOTE:-}
TODAY=${BACKUP_TODAY:-$(date -u +%Y%m%d)}
METRICS_DIR=$BACKUP_DIR/metrics
LOCK_DIR=$BACKUP_DIR/.lock

log() {
    printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
    log "ERROR: $*"
    exit 1
}

# Renders the .prom file from the per-target state files, so a failed run
# keeps the timestamp of the last success.
write_metrics() {
    mkdir -p "$METRICS_DIR"
    tmp=$METRICS_DIR/backup.prom.tmp
    {
        echo '# HELP backup_last_success_timestamp Unix time of the last successful backup per target.'
        echo '# TYPE backup_last_success_timestamp gauge'
        for target in local offsite; do
            if [ -s "$METRICS_DIR/.$target.ts" ]; then
                printf 'backup_last_success_timestamp{target="%s"} %s\n' "$target" "$(cat "$METRICS_DIR/.$target.ts")"
            fi
        done
    } > "$tmp"
    mv "$tmp" "$METRICS_DIR/backup.prom"
}

mark_success() {
    mkdir -p "$METRICS_DIR"
    date -u +%s > "$METRICS_DIR/.$1.ts"
    write_metrics
}

free_mb() {
    df -Pm "$BACKUP_DIR" | awk 'NR==2 {print $4}'
}

mkdir -p "$BACKUP_DIR"
if ! mkdir "$LOCK_DIR" 2> /dev/null; then
    die "another backup is running (remove $LOCK_DIR if it is stale)"
fi
trap 'rmdir "$LOCK_DIR" 2> /dev/null || true; rm -f "$BACKUP_DIR"/*.tmp' EXIT

# Make sure the metrics file exists even before the first success.
write_metrics

# ---- 1. free space ---------------------------------------------------------
uploads_mb=0
if [ -d "$DATA_DIR/uploads" ]; then
    uploads_mb=$(du -sm "$DATA_DIR/uploads" | awk '{print $1}')
fi
last_dump=$(ls -1 "$BACKUP_DIR"/db-*.dump 2> /dev/null | sort | tail -n 1 || true)
dump_mb=50
if [ -n "$last_dump" ]; then
    dump_mb=$(( $(du -sm "$last_dump" | awk '{print $1}') * 2 + 1 ))
fi
need_mb=$(( uploads_mb + dump_mb + MIN_FREE_MB ))
have_mb=$(free_mb)
if [ "$have_mb" -lt "$need_mb" ]; then
    die "not enough free space in $BACKUP_DIR: ${have_mb} MB available, ${need_mb} MB required (uploads ${uploads_mb}, dump ${dump_mb}, reserve ${MIN_FREE_MB}); backup skipped"
fi

failed=0

# ---- 2. database dump ------------------------------------------------------
dump_file=$BACKUP_DIR/db-$TODAY.dump
log "dumping database to $dump_file"
if pg_dump -Fc -f "$dump_file.tmp" && pg_restore -l "$dump_file.tmp" > /dev/null; then
    mv "$dump_file.tmp" "$dump_file"
    # Rotation runs only after a verified dump, so a failure never shrinks the set.
    ls -1 "$BACKUP_DIR"/db-*.dump | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
        log "removing old dump $old"
        rm -f "$old"
    done
else
    rm -f "$dump_file.tmp"
    log "ERROR: pg_dump failed"
    failed=1
fi

# ---- 3. uploads snapshot (single rolling copy) ------------------------------
snapshot=$BACKUP_DIR/uploads.tar
if [ -d "$DATA_DIR/uploads" ]; then
    log "snapshotting uploads (${uploads_mb} MB)"
    if tar -C "$DATA_DIR" -cf "$snapshot.tmp" uploads; then
        mv "$snapshot.tmp" "$snapshot"
    else
        rm -f "$snapshot.tmp"
        log "ERROR: uploads snapshot failed"
        failed=1
    fi
else
    log "no $DATA_DIR/uploads directory, snapshot skipped"
fi

if [ "$failed" -eq 0 ]; then
    mark_success local
    log "local backup complete"
fi

# ---- 4. off-site upload (rclone crypt) -----------------------------------------
if [ -n "$REMOTE" ] && [ "$failed" -eq 0 ]; then
    remote_name=${REMOTE%%:*}
    if [ "$remote_name" = "$REMOTE" ]; then
        die "BACKUP_REMOTE must look like 'name:' or 'name:path'"
    fi
    # Backups contain personal data: never upload to a plain remote.
    if ! rclone config show "$remote_name" 2> /dev/null | grep -q '^type = crypt'; then
        die "remote '$remote_name' is not an rclone crypt remote; off-site upload refused"
    fi
    base=${REMOTE%/}
    case $base in
        *:) ;;
        *) base=$base/ ;;
    esac
    log "uploading to $remote_name"
    offsite_ok=1
    rclone copyto "$dump_file" "${base}db/db-$TODAY.dump" || offsite_ok=0
    if [ -f "$snapshot" ]; then
        rclone copyto "$snapshot" "${base}uploads/uploads.tar" || offsite_ok=0
    fi
    if [ "$offsite_ok" -eq 1 ]; then
        mark_success offsite
        log "off-site upload complete"
    else
        log "ERROR: off-site upload failed"
        failed=1
    fi
fi

[ "$failed" -eq 0 ] || exit 1
log "done"
