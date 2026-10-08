#!/usr/bin/env bash
# End-to-end test of bay-restore + bay-restore-engine.py on a disposable
# Ubuntu 24.04 machine (run as root; it installs packages and creates users).
#
# Builds a bay-shaped host: PostgreSQL 16 archiving through pgBackRest to a
# TLS S3 gateway (versitygw, POSIX backed) standing in for R2, and a Conat SQLite tree backed up with rustic.
# Writes rows and SQLite snapshots before and after a target time, then:
#   1. bay-restore restore --target-time T --no-cutover  -> state at T only
#   2. bay-restore cutover                               -> bay runs on it
#   3. bay-restore restore --latest --no-cutover         -> every row
# Usage: sudo bash bay-restore-e2e.sh SRC/scripts/bay-systemd
set -euo pipefail
BAY_SYSTEMD="$(cd "${1:?usage: bay-restore-e2e.sh SRC/scripts/bay-systemd}" && pwd)"
export DEBIAN_FRONTEND=noninteractive
log() { echo "e2e: $*"; }
fail() { echo "E2E FAIL: $*" >&2; exit 1; }

log "installing PostgreSQL 16, pgBackRest, rustic, versitygw"
apt-get update -qq
apt-get install -y -qq postgresql-16 pgbackrest sqlite3 curl openssl python3 unzip >/dev/null
systemctl stop postgresql >/dev/null 2>&1 || true
curl -fsSL https://github.com/sagemathinc/rustic/releases/download/v0.11.1/rustic-v0.11.1-linux-x86_64.tar.gz |
  tar -xz -C /usr/local/bin rustic
curl -fsSL https://github.com/versity/versitygw/releases/download/v1.8.0/versitygw_v1.8.0_Linux_x86_64.tar.gz |
  tar -xz -C /usr/local/bin --strip-components=1 versitygw_v1.8.0_Linux_x86_64/versitygw
chmod 755 /usr/local/bin/versitygw /usr/local/bin/rustic
[[ -e /usr/local/bin/pgbackrest ]] || ln -s "$(command -v pgbackrest)" /usr/local/bin/pgbackrest

log "TLS S3 on localhost:443, trusted system-wide (as R2's CA is)"
mkdir -p /root/s3certs /srv/s3/e2e-bucket
# A test CA and a server certificate it signs (rustls rejects a self-signed
# CA certificate used directly by the server).
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=e2e test CA" \
  -keyout /root/s3certs/ca.key -out /root/s3certs/ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout /root/s3certs/private.key -out /root/s3certs/server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > /root/s3certs/ext.cnf
openssl x509 -req -in /root/s3certs/server.csr -CA /root/s3certs/ca.crt -CAkey /root/s3certs/ca.key \
  -CAcreateserial -days 2 -extfile /root/s3certs/ext.cnf -out /root/s3certs/public.crt 2>/dev/null
cp /root/s3certs/ca.crt /usr/local/share/ca-certificates/e2e-s3-ca.crt
update-ca-certificates >/dev/null
export MINIO_ROOT_USER=e2e-access MINIO_ROOT_PASSWORD=e2e-secret-key-123
nohup versitygw --access "$MINIO_ROOT_USER" --secret "$MINIO_ROOT_PASSWORD" --region auto --port 127.0.0.1:443 \
  --cert /root/s3certs/public.crt --key /root/s3certs/private.key posix /srv/s3 >/var/log/s3.log 2>&1 &
for _ in $(seq 60); do curl -s -o /dev/null https://localhost/ && break; sleep 1; done
curl -s -o /dev/null https://localhost/ || { cat /var/log/s3.log; fail "s3 server did not start"; }

log "bay layout and configuration"
id cocalc-bay >/dev/null 2>&1 || useradd --system --create-home cocalc-bay
mkdir -p /etc/cocalc /mnt/cocalc/bays/bay-0/sync/projects /mnt/cocalc/bays/bay-0/run /opt/cocalc/bay/current/bin /var/lib/e2e
cp "${BAY_SYSTEMD}/bin/lib.sh" "${BAY_SYSTEMD}/bin/bay-restore" "${BAY_SYSTEMD}/bin/bay-restore-engine.py" \
  /opt/cocalc/bay/current/bin/
cat > /opt/cocalc/bay/current/bin/bay-health <<'EOF'
#!/bin/bash
runuser -u cocalc-bay -- psql -X -h /mnt/cocalc/bays/bay-0/run -p 5432 -d cocalc-bay -tAc "select 1" | grep -q 1
EOF
chmod 755 /opt/cocalc/bay/current/bin/*
cat > /etc/cocalc/bay.env <<'EOF'
COCALC_BAY_ID=bay-0
COCALC_BAY_ROOT=/mnt/cocalc/bays/bay-0
COCALC_BAY_POSTGRES_DATA_DIR=/mnt/cocalc/bays/bay-0/postgres
COCALC_BAY_POSTGRES_SOCKET_DIR=/mnt/cocalc/bays/bay-0/run
COCALC_BAY_POSTGRES_USER=cocalc-bay
COCALC_BAY_POSTGRES_DB=cocalc-bay
EOF
cat > /etc/cocalc/bay-local.env <<'EOF'
COCALC_BAY_PGBACKREST_ENABLED=1
COCALC_BAY_PGBACKREST_S3_BUCKET=e2e-bucket
COCALC_BAY_PGBACKREST_S3_ENDPOINT=localhost
EOF
cat > /etc/cocalc/bay-secrets.env <<EOF
COCALC_BAY_PGBACKREST_S3_ACCESS_KEY=$MINIO_ROOT_USER
COCALC_BAY_PGBACKREST_S3_SECRET_KEY=$MINIO_ROOT_PASSWORD
COCALC_BAY_PGBACKREST_CIPHER_PASS=e2e-cipher-pass
COCALC_BAY_SQLITE_RUSTIC_PASSWORD=e2e-rustic-pass
EOF
chmod 600 /etc/cocalc/bay-secrets.env
chown -R cocalc-bay:cocalc-bay /mnt/cocalc/bays/bay-0

# pgBackRest for the live cluster.
cat > /etc/pgbackrest.conf <<'EOF'
[global]
repo1-type=s3
repo1-path=/pgbackrest/bay-0
repo1-s3-bucket=e2e-bucket
repo1-s3-endpoint=localhost
repo1-s3-region=auto
repo1-s3-uri-style=path
repo1-s3-key=e2e-access
repo1-s3-key-secret=e2e-secret-key-123
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=e2e-cipher-pass
log-level-file=off
start-fast=y

[cocalc-bay-0]
pg1-path=/mnt/cocalc/bays/bay-0/postgres
pg1-socket-path=/mnt/cocalc/bays/bay-0/run
pg1-port=5432
EOF
chown cocalc-bay /etc/pgbackrest.conf
chmod 600 /etc/pgbackrest.conf

PG=/usr/lib/postgresql/16/bin
DATA=/mnt/cocalc/bays/bay-0/postgres
bay() { runuser -u cocalc-bay -- "$@"; }
psql_bay() { bay psql -X -h /mnt/cocalc/bays/bay-0/run -p 5432 -d cocalc-bay -tAc "$1"; }
marks() { psql_bay "select string_agg(phase, ',' order by at) from marks"; }

log "live cluster with archiving, managed by systemd as on a bay"
bay "$PG/initdb" -D "$DATA" -U cocalc-bay >/dev/null
cat >> "$DATA/postgresql.conf" <<'EOF'
listen_addresses = ''
unix_socket_directories = '/mnt/cocalc/bays/bay-0/run'
archive_timeout = 10
EOF
cat > /etc/systemd/system/cocalc-bay-postgres.service <<EOF
[Unit]
PartOf=cocalc-bay.target
[Service]
User=cocalc-bay
ExecStart=$PG/postgres -D $DATA -c archive_mode=on -c "archive_command=pgbackrest --stanza=cocalc-bay-0 archive-push %%p"
Restart=always
EOF
cat > /etc/systemd/system/cocalc-bay.target <<'EOF'
[Unit]
Wants=cocalc-bay-postgres.service
EOF
systemctl daemon-reload
systemctl start cocalc-bay.target
for _ in $(seq 30); do bay psql -X -h /mnt/cocalc/bays/bay-0/run -d postgres -tAc "select 1" >/dev/null 2>&1 && break; sleep 1; done
bay createdb -h /mnt/cocalc/bays/bay-0/run cocalc-bay
psql_bay "create table accounts(id int); create table projects(id int); create table server_settings(name text); create table marks(phase text, at timestamptz default clock_timestamp())" >/dev/null
psql_bay "insert into marks(phase) values ('base')" >/dev/null
bay pgbackrest --stanza=cocalc-bay-0 stanza-create >/dev/null
bay pgbackrest --stanza=cocalc-bay-0 --type=full backup >/dev/null

log "Conat SQLite tree, snapshot before the target"
for name in a b c; do
  sqlite3 "/mnt/cocalc/bays/bay-0/sync/projects/$name.db" "create table t(x); insert into t values ('$name');"
done
chown -R cocalc-bay:cocalc-bay /mnt/cocalc/bays/bay-0/sync
cat > /root/sqlite-repo.toml <<EOF
[repository]
repository = "opendal:s3"
password = "e2e-rustic-pass"
[repository.options]
endpoint = "https://localhost"
region = "auto"
bucket = "e2e-bucket"
root = "rustic/bay-sqlite/bay-0"
access_key_id = "$MINIO_ROOT_USER"
secret_access_key = "$MINIO_ROOT_PASSWORD"
EOF
rustic -P /root/sqlite-repo init >/var/lib/e2e/rustic.log 2>&1 || { cat /var/lib/e2e/rustic.log; fail "rustic init"; }
( cd /mnt/cocalc/bays/bay-0/sync && rustic -P /root/sqlite-repo backup . >>/var/lib/e2e/rustic.log 2>&1 ) || fail "rustic backup"

psql_bay "insert into marks(phase) values ('before')" >/dev/null
sleep 2
TARGET="$(date -u '+%Y-%m-%d %H:%M:%S+00')"
sleep 2
psql_bay "insert into marks(phase) values ('after')" >/dev/null
sqlite3 /mnt/cocalc/bays/bay-0/sync/projects/a.db "insert into t values ('after-target')"
( cd /mnt/cocalc/bays/bay-0/sync && rustic -P /root/sqlite-repo backup . >>/var/lib/e2e/rustic.log 2>&1 ) || fail "rustic backup 2"
psql_bay "select pg_switch_wal()" >/dev/null
sleep 20  # archive_timeout + archive-push

RESTORE=/opt/cocalc/bay/current/bin/bay-restore
log "1. restore to $TARGET without cutover"
"$RESTORE" restore --target-time "$TARGET" --no-cutover --work-dir /mnt/cocalc/bays/bay-0/restore-pitr \
  > /var/lib/e2e/pitr.log 2>&1 || { tail -80 /var/lib/e2e/pitr.log; fail "PITR restore failed"; }
grep -q "verified restore ready" /var/lib/e2e/pitr.log || fail "no ready message"
python3 - <<'EOF' || fail "PITR result"
import json
r = json.load(open("/mnt/cocalc/bays/bay-0/restore-pitr/result.json"))
assert r["status"] == "passed", r
assert r["postgres"]["cluster_state"] == "shut down", r
assert r["conat"]["database_count"] == 3 and r["conat"]["quick_check_passed"] == 3, r["conat"]
print("e2e: pitr stage_seconds", r["stage_seconds"])
print("e2e: pitr recovered_to", r["postgres"]["recovered_to"])
EOF
[[ "$(marks)" == "base,before,after" ]] || fail "the live cluster changed: $(marks)"
grep -q "restore_command\|recovery_target\|cocalc bay restore" \
  /mnt/cocalc/bays/bay-0/restore-pitr/postgres/postgresql.auto.conf && fail "recovery settings left behind"
[[ ! -e /mnt/cocalc/bays/bay-0/restore-pitr/postgres/recovery.signal ]] || fail "recovery.signal left behind"
cmp -s "$DATA/pg_hba.conf" /mnt/cocalc/bays/bay-0/restore-pitr/postgres/pg_hba.conf || fail "pg_hba.conf changed"
# Point in time for Conat too: the snapshot before the target.
[[ "$(sqlite3 /mnt/cocalc/bays/bay-0/restore-pitr/sync/projects/a.db 'select count(*) from t')" == 1 ]] ||
  fail "PITR used a Conat snapshot after the target"

log "2. cutover"
"$RESTORE" cutover --work-dir /mnt/cocalc/bays/bay-0/restore-pitr --yes > /var/lib/e2e/cutover.log 2>&1 ||
  { tail -40 /var/lib/e2e/cutover.log; fail "cutover failed"; }
[[ "$(marks)" == "base,before" ]] || fail "after cutover expected base,before; got $(marks)"
[[ "$(psql_bay "select pg_is_in_recovery()")" == "f" ]] || fail "restored cluster in recovery"
[[ "$(psql_bay "show archive_mode")" == "on" ]] || fail "archive_mode not on after cutover"
[[ -d /mnt/cocalc/bays/bay-0/restore-pitr/pre-restore/postgres ]] || fail "previous data not kept"
[[ "$(sqlite3 /mnt/cocalc/bays/bay-0/sync/projects/a.db 'select count(*) from t')" == 1 ]] || fail "sync not swapped"
psql_bay "insert into marks(phase) values ('post-cutover')" >/dev/null
psql_bay "select pg_switch_wal()" >/dev/null
sleep 20
bay pgbackrest --stanza=cocalc-bay-0 --type=full backup >/dev/null 2>&1 || fail "backup on the new timeline"

log "3. restore the latest state without cutover"
"$RESTORE" restore --latest --no-cutover --work-dir /mnt/cocalc/bays/bay-0/restore-latest \
  --skip-sqlite-check > /var/lib/e2e/latest.log 2>&1 || { tail -80 /var/lib/e2e/latest.log; fail "latest restore failed"; }
python3 - <<'EOF' || fail "latest result"
import json
r = json.load(open("/mnt/cocalc/bays/bay-0/restore-latest/result.json"))
assert r["status"] == "passed", r
assert r["conat"]["quick_check_skipped"] is True, r["conat"]
print("e2e: latest stage_seconds", r["stage_seconds"])
EOF
mkdir -p /mnt/cocalc/bays/bay-0/inspect && chown cocalc-bay /mnt/cocalc/bays/bay-0/inspect
runuser -u cocalc-bay -- "$PG/postgres" -D /mnt/cocalc/bays/bay-0/restore-latest/postgres \
  -k /mnt/cocalc/bays/bay-0/inspect -p 55999 -c listen_addresses= -c archive_mode=off \
  > /var/lib/e2e/inspect.log 2>&1 &
inspect=$!
rows=""
for _ in $(seq 30); do
  rows="$(runuser -u cocalc-bay -- psql -X -h /mnt/cocalc/bays/bay-0/inspect -p 55999 -d cocalc-bay -tAc "select string_agg(phase, ',' order by at) from marks" 2>/dev/null)" && [[ -n "$rows" ]] && break
  sleep 1
done
kill -INT "$inspect" 2>/dev/null || true
[[ "$rows" == "base,before,post-cutover" ]] || fail "latest restore expected base,before,post-cutover; got '$rows'"
[[ "$(sqlite3 /mnt/cocalc/bays/bay-0/restore-latest/sync/projects/a.db 'select count(*) from t')" == 2 ]] ||
  fail "latest restore did not use the newest Conat snapshot"

echo "E2E PASSED"
