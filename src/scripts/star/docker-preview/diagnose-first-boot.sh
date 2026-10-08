#!/usr/bin/env bash
# Fresh CoCalc Star first boot that captures why the project host does not
# register. Usage: bash star-docker-diagnose.sh <image>
# WARNING: deletes the cocalc-star container and the cocalc-star volume.
set -u
IMAGE="${1:?usage: star-docker-diagnose.sh <image>}"
docker rm -f cocalc-star >/dev/null 2>&1
docker volume rm cocalc-star >/dev/null 2>&1
docker run -d --name cocalc-star --privileged --cgroupns=host \
  -v cocalc-star:/var/lib/cocalc -p 8170:80 -e COCALC_STAR_HTTP_PORT=8170 \
  "$IMAGE" >/dev/null
echo "waiting for the registration step..."
until docker logs cocalc-star 2>&1 | grep -q -e "waiting for project host registration" -e "is ready"; do
  sleep 5
done
echo "in the registration step; capturing state in 60s..."
sleep 60
docker exec cocalc-star bash -c '
set -a; source /etc/cocalc/star/hub.env; set +a
echo "=== project_hosts row"
sudo -E -u cocalc-star psql -X -At -c "select status, last_seen, now(), bay_id, metadata#>>'"'"'{runtime_synthetic_probe,status}'"'"', metadata#>>'"'"'{runtime_synthetic_probe,quarantined}'"'"', left(metadata#>>'"'"'{runtime_synthetic_probe,error}'"'"', 1500) from project_hosts" 2>&1
echo "=== services"
systemctl is-active cocalc-star-hub cocalc-star-project-host cocalc-star-rest-server 2>&1
echo "=== project-host journal"
journalctl -u cocalc-star-project-host -n 40 --no-pager -o cat 2>&1 | grep -v pam_unix | cut -c1-400
echo "=== hub journal (errors)"
journalctl -u cocalc-star-hub -n 400 --no-pager -o cat 2>&1 | grep -i -E "error|fail|warn|denied|host" | tail -30 | cut -c1-400
echo "=== conat logs"
tail -n 15 /mnt/cocalc/data/conat-router.log /mnt/cocalc/data/conat-persist.log 2>&1 | cut -c1-300
echo "=== project-host stdout"
tail -n 20 /mnt/cocalc/data/log 2>&1 | cut -c1-300
echo "=== kernel"
uname -a; nft list tables 2>&1 | head -5; ls /sys/fs/cgroup/cocalc-project-pool 2>&1 | head -3
'
