#!/bin/sh
# Per-container CPU / RAM / log size and per-volume disk size, written as a Prometheus textfile that node_exporter
# serves (--collector.textfile). cAdvisor is not used: it cannot see containers on Docker 29 (containerd snapshotter).
# Everything is read-only: cgroup v2 files, the container list from the Docker socket, and `du` over the volumes.
# The `service` label is the compose service for the tip stack and the container name for anything else.
set -eu

OUT=${OUT:-/backups/metrics/containers.prom}
CG=${CG:-/host/cgroup/system.slice}
DOCKER_DIR=${DOCKER_DIR:-/host/docker}
CONTAINERD_DIR=${CONTAINERD_DIR:-/host/containerd}
INTERVAL=${INTERVAL:-15}
DISK_EVERY=${DISK_EVERY:-300}

# Owner of a named volume; unknown volumes keep their own name.
volume_service() {
    case $1 in
        tip_pgdata) echo postgres ;;
        tip_redisdata) echo redis ;;
        tip_uploads) echo tipd ;;
        tip_promdata) echo prometheus ;;
        tip_lokidata) echo loki ;;
        tip_grafanadata) echo grafana ;;
        tip_backups) echo backup ;;
        tip_caddy) echo caddy ;;
        old_tip_database_pg_data) echo old_tip_database-db-1 ;;
        *) echo "$1" ;;
    esac
}

# Fills $cpu, $mem, $lim and $logs with one metric line per running container.
collect_containers() {
    cpu='' mem='' lim='' logs=''
    list=$(docker ps --no-trunc --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}} {{.Label "com.docker.compose.service"}}')
    while read -r id name project service; do
        dir=$CG/docker-$id.scope
        [ -r "$dir/cpu.stat" ] || continue
        [ "$project" = tip ] && [ -n "$service" ] && name=$service
        # A container that stopped since `docker ps` has no cgroup any more: skip it instead of dying.
        usec=$(sed -n 's/^usage_usec //p' "$dir/cpu.stat") || continue
        current=$(cat "$dir/memory.current") || continue
        inactive=$(sed -n 's/^inactive_file //p' "$dir/memory.stat") || continue
        limit=$(cat "$dir/memory.max") || continue
        [ "$limit" = max ] && limit=0
        logsize=$(stat -c %s "$DOCKER_DIR/containers/$id/$id-json.log" 2> /dev/null || echo 0)
        secs=$(awk -v u="$usec" 'BEGIN { printf "%.6f", u / 1000000 }')
        cpu="$cpu
tip_container_cpu_seconds_total{service=\"$name\"} $secs"
        mem="$mem
tip_container_memory_working_set_bytes{service=\"$name\"} $((current - ${inactive:-0}))"
        lim="$lim
tip_container_memory_limit_bytes{service=\"$name\"} $limit"
        logs="$logs
tip_container_log_bytes{service=\"$name\"} $logsize"
    done << EOF
$list
EOF
}

# Volume sizes and the image store; `du` walks every file, so this runs every DISK_EVERY seconds, not every tick.
collect_disk() {
    vols=''
    for dir in "$DOCKER_DIR"/volumes/*/; do
        [ -d "${dir}_data" ] || continue
        vol=$(basename "$dir")
        kb=$(du -x -sk "${dir}_data" 2> /dev/null | cut -f1)
        vols="$vols
tip_volume_bytes{volume=\"$vol\",service=\"$(volume_service "$vol")\"} $((${kb:-0} * 1024))"
    done
    images_kb=$(du -x -sk "$CONTAINERD_DIR" 2> /dev/null | cut -f1)
    images="tip_docker_images_bytes $((${images_kb:-0} * 1024))"
}

write_out() {
    tmp=$OUT.tmp
    {
        echo '# HELP tip_container_cpu_seconds_total CPU time used by the container.'
        echo '# TYPE tip_container_cpu_seconds_total counter'
        echo "$cpu" | sed '/^$/d'
        echo '# HELP tip_container_memory_working_set_bytes Container memory without reclaimable page cache.'
        echo '# TYPE tip_container_memory_working_set_bytes gauge'
        echo "$mem" | sed '/^$/d'
        echo '# HELP tip_container_memory_limit_bytes Container memory limit, 0 when unlimited.'
        echo '# TYPE tip_container_memory_limit_bytes gauge'
        echo "$lim" | sed '/^$/d'
        echo '# HELP tip_container_log_bytes Size of the container json log file.'
        echo '# TYPE tip_container_log_bytes gauge'
        echo "$logs" | sed '/^$/d'
        echo '# HELP tip_volume_bytes Disk space taken by a named volume.'
        echo '# TYPE tip_volume_bytes gauge'
        echo "$vols" | sed '/^$/d'
        echo '# HELP tip_docker_images_bytes Disk space taken by images and layers.'
        echo '# TYPE tip_docker_images_bytes gauge'
        echo "$images"
    } > "$tmp"
    mv "$tmp" "$OUT"
}

mkdir -p "$(dirname "$OUT")"
since_disk=$DISK_EVERY
while :; do
    if [ "$since_disk" -ge "$DISK_EVERY" ]; then
        collect_disk
        since_disk=0
    fi
    collect_containers
    write_out
    sleep "$INTERVAL"
    since_disk=$((since_disk + INTERVAL))
done
