#!/bin/sh
# Offline tests for backup.sh and restore.sh with stubbed pg_dump, pg_restore
# and rclone. Run inside any POSIX environment:
#   docker run --rm -v "$PWD:/b:ro" alpine:3.23 sh /b/test.sh
# shellcheck disable=SC2012
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/data/uploads/projects/ab" "$WORK/backups"
echo image-bytes > "$WORK/data/uploads/projects/ab/abcdef"

# Stubs ----------------------------------------------------------------------
cat > "$WORK/bin/pg_dump" << 'EOF'
#!/bin/sh
# usage: pg_dump -Fc -f FILE
[ "${FAKE_PG_FAIL:-0}" = "1" ] && exit 1
echo "PGDMP fake" > "$3"
EOF
cat > "$WORK/bin/pg_restore" << 'EOF'
#!/bin/sh
# Only `-l FILE` (verification) is exercised.
[ "$1" = "-l" ] || exit 0
grep -q PGDMP "$2"
EOF
cat > "$WORK/bin/rclone" << 'EOF'
#!/bin/sh
case $1 in
    config) printf 'type = %s\n' "${FAKE_REMOTE_TYPE:-crypt}" ;;
    copyto) echo "$2 -> $3" >> "$RCLONE_LOG" ;;
esac
EOF
chmod +x "$WORK/bin/pg_dump" "$WORK/bin/pg_restore" "$WORK/bin/rclone"

PATH="$WORK/bin:$PATH"
export PATH
export BACKUP_DIR="$WORK/backups" DATA_DIR="$WORK/data" BACKUP_MIN_FREE_MB=0 RCLONE_LOG="$WORK/rclone.log"

pass=0
fail() { echo "FAIL: $*"; exit 1; }
ok() { pass=$((pass + 1)); echo "ok: $*"; }

# 1. five days of backups keep only three dumps ----------------------------------
for day in 20260101 20260102 20260103 20260104 20260105; do
    BACKUP_KEEP=3 BACKUP_TODAY=$day sh "$HERE/backup.sh" > /dev/null
done
count=$(ls "$WORK"/backups/db-*.dump | wc -l)
[ "$count" -eq 3 ] || fail "expected 3 dumps, got $count"
[ -f "$WORK/backups/db-20260105.dump" ] || fail "newest dump missing"
[ ! -f "$WORK/backups/db-20260102.dump" ] || fail "old dump not rotated"
ok "rotation keeps the newest 3 dumps"

[ -f "$WORK/backups/uploads.tar" ] || fail "uploads snapshot missing"
tar -tf "$WORK/backups/uploads.tar" | grep -q 'uploads/projects/ab/abcdef' || fail "snapshot content"
ok "uploads snapshot written"

grep -q '^backup_last_success_timestamp{target="local"} [0-9]*$' "$WORK/backups/metrics/backup.prom" || fail "local metric"
! grep -q 'offsite' "$WORK/backups/metrics/backup.prom" || fail "offsite metric without remote"
ok "local metric written, no offsite metric without a remote"

# 2. a failed dump keeps old files and the old timestamp ---------------------------
before=$(cat "$WORK/backups/metrics/backup.prom")
if FAKE_PG_FAIL=1 BACKUP_TODAY=20260106 sh "$HERE/backup.sh" > /dev/null; then fail "failed dump must exit non-zero"; fi
[ "$(ls "$WORK"/backups/db-*.dump | wc -l)" -eq 3 ] || fail "failed dump changed the dump set"
[ "$before" = "$(cat "$WORK/backups/metrics/backup.prom")" ] || fail "metric changed after failure"
ok "failed dump leaves backups and metric untouched"

# 3. low free space skips the backup ------------------------------------------------------
if BACKUP_MIN_FREE_MB=999999999 BACKUP_TODAY=20260107 sh "$HERE/backup.sh" > /dev/null; then fail "low space must fail"; fi
[ ! -f "$WORK/backups/db-20260107.dump" ] || fail "dump written despite low space"
ok "low free space skips the backup"

# 4. off-site upload only to a crypt remote -------------------------------------------------
: > "$RCLONE_LOG"
BACKUP_REMOTE=tipcrypt:tip BACKUP_TODAY=20260108 sh "$HERE/backup.sh" > /dev/null
grep -q 'tipcrypt:tip/db/db-20260108.dump' "$RCLONE_LOG" || fail "dump not uploaded"
grep -q 'tipcrypt:tip/uploads/uploads.tar' "$RCLONE_LOG" || fail "snapshot not uploaded"
grep -q 'target="offsite"' "$WORK/backups/metrics/backup.prom" || fail "offsite metric"
ok "off-site upload through a crypt remote writes the offsite metric"

: > "$RCLONE_LOG"
if FAKE_REMOTE_TYPE=s3 BACKUP_REMOTE=plain: BACKUP_TODAY=20260109 sh "$HERE/backup.sh" > /dev/null; then fail "plain remote must be refused"; fi
[ ! -s "$RCLONE_LOG" ] || fail "uploaded to a non-crypt remote"
ok "non-crypt remote is refused"

# 5. restore picks the newest dump and requires confirmation ----------------------------------
out=$(sh "$HERE/restore.sh" db --yes 2>&1)
echo "$out" | grep -q 'db-20260109.dump\|db-20260108.dump' || fail "restore did not use the newest dump: $out"
ok "restore db uses the newest dump"

if echo no | sh "$HERE/restore.sh" db > /dev/null 2>&1; then fail "restore without confirmation must abort"; fi
ok "restore aborts without the confirmation word"

rm -rf "$WORK/data/uploads"
sh "$HERE/restore.sh" uploads --yes > /dev/null
[ -f "$WORK/data/uploads/projects/ab/abcdef" ] || fail "uploads not restored"
ok "restore uploads extracts the snapshot"

echo "all $pass checks passed"
