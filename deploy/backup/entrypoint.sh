#!/bin/sh
# Installs the crontab from BACKUP_CRON and runs busybox crond in the
# foreground. Job output goes to the container log (PID 1 stdout) so Vector
# ships it to Loki. busybox crond passes its own environment to jobs, which is
# how PG* / BACKUP_* / RCLONE_* variables reach backup.sh.
set -eu

CRON_EXPR=${BACKUP_CRON:-30 1 * * *}

mkdir -p /etc/crontabs
printf '%s /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1\n' "$CRON_EXPR" > /etc/crontabs/root

echo "backup: schedule '$CRON_EXPR', keep ${BACKUP_KEEP:-3} dumps, remote '${BACKUP_REMOTE:-none}'"
exec crond -f -l 8
