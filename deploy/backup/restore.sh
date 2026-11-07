#!/bin/sh
# Restore helper. Destructive: always asks for confirmation (use --yes only
# in scripted drills). Stop tipd first so nothing writes during the restore.
#
#   restore.sh list
#   restore.sh db [DUMP_FILE]        restore the database (default: newest dump)
#   restore.sh uploads [TAR_FILE]    replace $DATA_DIR/uploads (needs a writable mount)
#   restore.sh fetch                 download the newest off-site backup to $BACKUP_DIR/offsite
#
# Environment: PG* (libpq), BACKUP_DIR, DATA_DIR, BACKUP_REMOTE, RCLONE_CONFIG.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
DATA_DIR=${DATA_DIR:-/data}
REMOTE=${BACKUP_REMOTE:-}
ASSUME_YES=0

usage() {
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
}

# Strip --yes wherever it appears.
args=""
for a in "$@"; do
    if [ "$a" = "--yes" ]; then
        ASSUME_YES=1
    else
        args="$args $a"
    fi
done
# shellcheck disable=SC2086
set -- $args

[ $# -ge 1 ] || usage
cmd=$1
shift

confirm() {
    # $1 = what will happen, $2 = word that must be typed
    echo "$1"
    if [ "$ASSUME_YES" -eq 1 ]; then
        return 0
    fi
    printf "Type '%s' to continue: " "$2"
    read -r answer
    [ "$answer" = "$2" ] || { echo "aborted"; exit 1; }
}

base_remote() {
    [ -n "$REMOTE" ] || { echo "BACKUP_REMOTE is not set" >&2; exit 1; }
    base=${REMOTE%/}
    case $base in
        *:) ;;
        *) base=$base/ ;;
    esac
    printf '%s' "$base"
}

newest_dump() {
    # Names are db-YYYYMMDD.dump, so the last glob match is the newest.
    newest=""
    for f in "$1"/db-*.dump; do
        [ -f "$f" ] && newest=${f##*/}
    done
    printf '%s' "$newest"
}

case $cmd in
    list)
        ls -lh "$BACKUP_DIR"
        ;;

    db)
        file=${1:-}
        if [ -z "$file" ]; then
            latest=$(newest_dump "$BACKUP_DIR")
            [ -n "$latest" ] || { echo "no dump found in $BACKUP_DIR" >&2; exit 1; }
            file=$BACKUP_DIR/$latest
        fi
        [ -f "$file" ] || { echo "dump not found: $file" >&2; exit 1; }
        pg_restore -l "$file" > /dev/null || { echo "dump is not readable: $file" >&2; exit 1; }
        db=${PGDATABASE:-tip}
        confirm "This DROPS and recreates all objects in database '$db' from $file." "$db"
        # --clean --if-exists replaces existing objects; ownership is taken
        # from the connecting role.
        pg_restore --clean --if-exists --no-owner --no-privileges -d "$db" "$file"
        echo "database restored from $file; start tipd again"
        ;;

    uploads)
        file=${1:-$BACKUP_DIR/uploads.tar}
        [ -f "$file" ] || { echo "snapshot not found: $file" >&2; exit 1; }
        tar -tf "$file" > /dev/null || { echo "snapshot is not readable: $file" >&2; exit 1; }
        touch "$DATA_DIR/.write-test" 2> /dev/null || { echo "$DATA_DIR is read-only: mount the uploads volume read-write" >&2; exit 1; }
        rm -f "$DATA_DIR/.write-test"
        confirm "This REPLACES $DATA_DIR/uploads with the contents of $file." "uploads"
        rm -rf "${DATA_DIR:?}/uploads"
        tar -C "$DATA_DIR" -xf "$file"
        # tipd runs as uid 65532 (distroless nonroot).
        chown -R 65532:65532 "$DATA_DIR/uploads"
        echo "uploads restored from $file"
        ;;

    fetch)
        base=$(base_remote)
        out=$BACKUP_DIR/offsite
        mkdir -p "$out"
        latest=$(rclone lsf "${base}db" | sort | tail -n 1)
        [ -n "$latest" ] || { echo "no dumps on the remote" >&2; exit 1; }
        rclone copyto "${base}db/$latest" "$out/$latest"
        rclone copyto "${base}uploads/uploads.tar" "$out/uploads.tar"
        echo "downloaded $latest and uploads.tar to $out"
        echo "next: restore.sh db $out/$latest ; restore.sh uploads $out/uploads.tar"
        ;;

    *)
        usage
        ;;
esac
