# Restoring a CoCalc bay

This is the runbook for bringing a bay back from its backups. It is written so
that an agent with shell access can carry it out with a human supplying only
two secrets. Everything else (configuration, other secrets, data) comes from
the backups in R2.

The restore is done by `bin/bay-restore`, which runs `bin/bay-restore-engine.py`:
the same engine the weekly disposable PITR drill runs (`cocalc bay restore-test
<bay> --disposable-gcp`). A passing drill means this procedure works for the
backups as they are now.

## If you are an agent asked to restore CoCalc, read this first

1. **Ask the human for exactly these, and nothing else:**
   - **The site master key** (1Password: "CoCalc site master key"). It is a
     44-character base64 string; save it as a file, never paste it into chat
     logs or command lines.
   - **Only for a lost bay VM (mode B):** read access to the backup bucket in
     R2: the R2 endpoint (`https://<account>.r2.cloudflarestorage.com`), the
     bucket name, and an access key id + secret with read permission on that
     bucket (1Password: "CoCalc bay restore R2 access", or create one in the
     Cloudflare dashboard: R2 > Manage API tokens > Object Read, scoped to the
     bucket).
2. **Decide which mode applies:**
   - **Mode A, restore in place:** the bay VM and its disks are fine, but the
     data must go back to an earlier time (bad migration, mass deletion,
     corruption), or PostgreSQL's data directory is damaged. Fastest.
   - **Mode B, new VM:** the bay VM or its data disk is gone. If the old data
     disk survives, attach it to a new VM and use mode A instead.
3. Never print, copy into chat, or commit any secret. All secrets live in
   `/etc/cocalc/` (root, 0600) and the bay secrets directory.
4. `bay-restore` never modifies the live data until `cutover`, and cutover keeps
   the previous data under `<work-dir>/pre-restore/`. If a step fails, stop and
   report the exact error.
5. Expect, for a production-sized bay (about 175 GB of PostgreSQL), a restore
   of roughly an hour plus the WAL replay since the last daily backup. The
   engine prints the time each stage took.

Paths below assume bay `bay-0`; substitute the real bay id.

## Mode A: restore in place

On the bay host (for prod: `gcloud compute ssh ubuntu@prod-bay-0
--project=projecthosts --zone=us-south1-a --tunnel-through-iap`):

1. Choose the recovery point:
   - `--target-time "2026-10-08 03:00:00+00"`: the state just before that time
     (UTC). Use this to undo something. PostgreSQL stops before the first
     transaction after the target; Conat uses its newest hourly snapshot at or
     before it.
   - `--latest`: every archived transaction (for a damaged data directory).
2. Check space: the restore is written next to the live data and needs about
   the database size plus 10% free on `/mnt/cocalc` (`df -h /mnt/cocalc`).
   The engine refuses to start without it.
3. Restore and verify without touching the live bay:

   ```sh
   sudo /opt/cocalc/bay/current/bin/bay-restore restore \
     --target-time "2026-10-08 03:00:00+00" --no-cutover
   ```

   It prints the work directory, the backup set, where recovery stopped
   (`recovered to`), the Conat snapshot used, and the time per stage. Details
   are in `<work-dir>/engine.log` and `<work-dir>/result.json`.
4. Swap it in (stops the bay, moves the live `postgres` and `sync`
   directories to `<work-dir>/pre-restore/`, starts the bay, waits for
   `bay-health`):

   ```sh
   sudo /opt/cocalc/bay/current/bin/bay-restore cutover --work-dir <work-dir>
   ```

   Omit `--no-cutover` in step 3 to do both in one command (it asks first;
   `--yes` skips the question).
5. After cutover: check the site, then `cocalc bay backups bay-0` (a fresh full
   pgBackRest backup was started automatically, because a point-in-time
   restore starts a new timeline). Delete `<work-dir>` once satisfied.

To undo a cutover: `sudo systemctl stop cocalc-bay.target`, move
`/mnt/cocalc/bays/bay-0/{postgres,sync}` aside, move
`<work-dir>/pre-restore/{postgres,sync}` back, `sudo systemctl start
cocalc-bay.target`.

Project hosts keep running throughout. After a restore to an earlier time,
the database may not know about projects or files created after the target;
that state still exists on the hosts and in project backups.

## Mode B: rebuild the bay on a new VM

1. **Create the VM** like the old one. For prod bay-0: project `projecthosts`,
   zone `us-south1-a` (or another), machine type `t2d-standard-8`, Ubuntu
   24.04, 100 GB `pd-balanced` boot disk, a 500 GB `pd-ssd` data disk and a
   500 GB `pd-balanced` backups disk, network tags `cocalc-bay` and
   `cocalc-prod-hub-backend`:

   ```sh
   gcloud compute instances create prod-bay-0-restore --project=projecthosts \
     --zone=us-south1-a --machine-type=t2d-standard-8 \
     --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
     --boot-disk-size=100GB --boot-disk-type=pd-balanced \
     --create-disk=name=prod-bay-0-restore-data,size=500GB,type=pd-ssd,device-name=bay-data \
     --create-disk=name=prod-bay-0-restore-backups,size=500GB,type=pd-balanced,device-name=cocalc-backups \
     --tags=cocalc-bay,cocalc-prod-hub-backend
   ```

2. **Mount the disks** (on the VM, as root):

   ```sh
   mkfs.ext4 -F /dev/disk/by-id/google-bay-data
   mkfs.ext4 -F /dev/disk/by-id/google-cocalc-backups
   mkdir -p /mnt/cocalc /mnt/cocalc-backups
   echo "/dev/disk/by-id/google-bay-data /mnt/cocalc ext4 defaults,nofail,discard 0 2" >> /etc/fstab
   echo "/dev/disk/by-id/google-cocalc-backups /mnt/cocalc-backups ext4 defaults,nofail 0 2" >> /etc/fstab
   mount -a
   ```

3. **Prepare the host** from a checkout of this repository (the release you
   intend to run):

   ```sh
   git clone https://github.com/sagemathinc/cocalc-ai.git && cd cocalc-ai
   sudo ./src/scripts/bay-systemd/bay-bootstrap-host.sh --install-nodejs
   ```

   This creates the `cocalc-bay` user and installs the runtime libraries.

4. **Install the master key** (from the human, as a file):

   ```sh
   sudo install -o root -g root -m 0600 ./site-master-key /etc/cocalc/site-master-key
   ```

5. **Recover the configuration and secrets from the escrow.** The bay seals
   `/etc/cocalc/*.env` and its secrets directory into R2 daily
   (`cocalc-bay-config-escrow.timer`). With the R2 read access from the human:

   ```sh
   umask 077
   printf 'user = "%s:%s"\n' "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" > /root/r2.curl
   curl --config /root/r2.curl --aws-sigv4 aws:amz:auto:s3 --fail -o /root/bay-config.v1.json \
     "$R2_ENDPOINT/$R2_BUCKET/cocalc-escrow/bay-0/bay-config.v1.json"
   rm /root/r2.curl
   NODE="$(ls /opt/cocalc/nvm/versions/node/*/bin/node | tail -1)"   # from step 3
   "$NODE" src/scripts/bay-systemd/bin/bay-config-escrow.mjs info --in /root/bay-config.v1.json
   # The bay root belongs to the bay user; the secrets directory is created in it.
   sudo install -d -o cocalc-bay -g cocalc-bay -m 0755 /mnt/cocalc/bays /mnt/cocalc/bays/bay-0 \
     /mnt/cocalc/bays/bay-0/secrets
   sudo "$NODE" src/scripts/bay-systemd/bin/bay-config-escrow.mjs open \
     --master-key /etc/cocalc/site-master-key --in /root/bay-config.v1.json --chown \
     --map etc-cocalc=/etc/cocalc --map bay-secrets=/mnt/cocalc/bays/bay-0/secrets
   ```

   `info` shows when it was sealed; dated copies are under
   `cocalc-escrow/bay-0/history/` if an older one is needed. A wrong master key
   is reported as such.

6. **Install the release** without starting it (the escrowed env files are
   kept; only missing ones are generated):

   ```sh
   sudo ./src/scripts/bay-systemd/bay-bootstrap-release.sh --source "$PWD/src"
   ```

   (or `--bundle` with a built bay runtime bundle; see README.md, "Fresh VM
   Bootstrap").

7. **Install the backup tools** the restore needs:

   ```sh
   ./src/scripts/bay-systemd/build-pgbackrest.sh --install-deps --output /tmp/pgbackrest
   sudo install -m 0755 /tmp/pgbackrest /usr/local/bin/pgbackrest
   curl -fsSL https://github.com/sagemathinc/rustic/releases/download/v0.11.1/rustic-v0.11.1-linux-x86_64.tar.gz |
     sudo tar -xz -C /usr/local/bin rustic
   ```

8. **Restore and start the bay:**

   ```sh
   sudo /opt/cocalc/bay/current/bin/bay-restore restore --latest --yes
   ```

   This restores PostgreSQL to the newest archived transaction and Conat to its
   newest snapshot, moves any freshly initialized data aside, and starts the
   bay. Traffic reaches the new VM through the Cloudflare tunnel, whose
   credentials came from the escrow; DNS does not change.

9. **Afterwards:** confirm the site works; enable the backup timers listed in
   README.md ("Activation Order") and `cocalc-bay-config-escrow.timer`; stop or
   delete the old VM if it still exists, so two bays never run the same tunnel
   or archive into the same repository; run a disposable drill
   (`cocalc bay restore-test bay-0 --disposable-gcp`).

## Testing this procedure

- The weekly drill runs the engine against the real backups.
- `test/bay-restore-e2e.sh` runs `bay-restore` end to end on a disposable
  Ubuntu 24.04 VM against a local TLS S3 server: a point-in-time restore,
  cutover, and a restore of the latest state.
- `bin/bay-config-escrow.test.sh` tests the escrow.
