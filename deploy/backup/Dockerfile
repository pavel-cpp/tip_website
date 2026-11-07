# Nightly backup job: pg_dump + uploads snapshot + optional rclone upload.
# The PostgreSQL client major version must be >= the server version (18).
# VERIFY: alpine:3.23 provides postgresql18-client and rclone (checked 2026-11).
FROM alpine:3.23

RUN apk add --no-cache postgresql18-client rclone tzdata

COPY backup.sh restore.sh entrypoint.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/entrypoint.sh \
    && mkdir -p /backups

ENV BACKUP_DIR=/backups DATA_DIR=/data BACKUP_KEEP=3
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
