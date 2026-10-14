# Restoring a CoCalc bay

This is the runbook for bringing a bay back from its backups: PostgreSQL from
pgBackRest (to any point in time) and the Conat SQLite data from rustic, both
stored in R2. It is written so that an agent with shell access can carry it
out with a human supplying only two secrets. Everything else (configuration,
other secrets, data) comes from the backups.

## How the restore works

`bay-restore` does the restore; it runs as root.

- **The bay is down for the whole restore.** `bay-restore restore` first stops
  the backup timers, any running backup jobs and the bay's services, then ends
  every remaining process of the `cocalc-bay` account. Nothing of the bay's
  runs again until the restore has finished: root must not work on files that
  a process of the bay account could swap out underneath it.
- **The bay is fenced until the cutover.** Before it stops anything,
  `bay-restore` creates `/etc/cocalc/bay-restore-fence`. While that file
  exists, no bay unit starts: not at boot, not from a timer, not through
  `Restart=` (a drop-in on every `cocalc-bay*` unit makes the file a start
  condition). So a reboot during a restore, which can take hours, does not
  bring up a half-restored bay, its tunnel or its backup jobs. The cutover
  lifts the fence once the verified data is in place. A failed restore and
  `--no-cutover` lift the fence too, unless it was already there before the
  restore (mode B, below). If `bay-restore` itself is killed, the fence
  stays: run the restore again, or remove the file by hand to bring the bay
  back on its current data. A bay deploy refuses to run against a fenced
  bay: `bay-bootstrap-release.sh` checks before it stages anything, and
  `upgrade-bay-release.sh` checks again before each restart. The drop-ins
  and `bay-restore` are installed by `install-restore-tools.sh`, with every
  release and, in mode B, from current main.
- **The live data is not changed until the cutover.** The restore is built in
  a new work directory and verified there. Only then does the cutover move the
  live `postgres` and `sync` directories to `<work-dir>/pre-restore/`, move the
  restored ones into place, and start the bay. If anything fails before that,
  `bay-restore` restarts the bay on its unchanged data.
- **The work directory is root's.** By default it is
  `/mnt/cocalc/bays/.restore-<bay>/restore-<UTC time>`: a new directory,
  owned by root, in a directory owned by root, on the same filesystem as the
  live data (so the cutover is a rename). `--work-dir` must meet the same
  conditions.
- **Root runs only root-owned code.** `bay-restore` and its engine
  `bay-restore-engine.py` are installed root-owned in
  `/usr/local/libexec/cocalc-bay` by `install-scaffold.sh`, which the bay
  bootstrap runs. Always run that copy. The release tree under
  `/opt/cocalc/bay` belongs to the bay account, and `bay-restore` refuses to
  run as root from anywhere the bay account could change. The bay's own code,
  such as its `bay-health` check, runs as the bay account.

The weekly disposable PITR drill (`cocalc bay restore-test <bay>
--disposable-gcp`) runs the same engine against the real backups: fetching
and verifying the backups, the PostgreSQL recovery and the Conat checks. A
passing drill means the backups restore. The drill does not exercise what
only a production restore does: running on the bay host as root with fsync
on, the ownership hand-over and the cutover. Those are covered by the tests
listed at the end.

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
     corruption), or PostgreSQL's data directory is damaged.
   - **Mode B, new VM:** the bay VM or its data disk is gone. If the old data
     disk survives, attach it to a new VM and use mode A instead.
3. **Tell the human the site will be down** for the whole restore before you
   start it, and get their go-ahead.
4. Never print, copy into chat, or commit any secret. All secrets live in
   `/etc/cocalc/` (root, 0600) and the bay secrets directory.
5. If a step fails, stop and report the exact error. The previous data is
   never deleted: until the cutover it is still live, and afterwards it is in
   `<work-dir>/pre-restore/`.
6. Expect, for a production-sized bay (about 175 GB of PostgreSQL), roughly an
   hour plus the WAL replay since the last daily backup. The engine prints the
   time each stage took.

Paths below assume bay `bay-0`; substitute the real bay id.

## Mode A: restore in place

On the bay host (for prod: `gcloud compute ssh ubuntu@prod-bay-0
--project=projecthosts --zone=us-south1-a --tunnel-through-iap`):

1. **Choose the recovery point:**
   - `--target-time "2026-10-08 03:00:00+00"`: the state just before that time
     (UTC). Use this to undo something. PostgreSQL stops before the first
     transaction after the target; Conat uses its newest hourly snapshot at or
     before it.
   - `--latest`: every archived transaction (for a damaged data directory).
2. **Check space:** the restore needs about the database size plus 10% free on
   `/mnt/cocalc` (`df -h /mnt/cocalc`). The engine refuses to start without
   it.
3. **Restore.** This stops the bay, restores, verifies, and swaps the result
   in; it asks before stopping the bay and before the swap (`--yes` skips
   both questions):

   ```sh
   sudo /usr/local/libexec/cocalc-bay/bay-restore restore \
     --target-time "2026-10-08 03:00:00+00"
   ```

   It prints the work directory, the backup set, where recovery stopped
   (`recovered to`), the Conat snapshot used, and the time per stage. Details
   are in `<work-dir>/engine.log` and `<work-dir>/result.json`. After the swap
   it starts the bay, waits for `bay-health`, and restarts the backup timers.

   To inspect the result before swapping it in, add `--no-cutover`. The bay is
   then restarted on its old data once the restore is verified, and the swap
   is a separate step, which stops the bay again:

   ```sh
   sudo /usr/local/libexec/cocalc-bay/bay-restore cutover --work-dir <work-dir>
   ```

4. **After the cutover:** check the site, then `cocalc bay backups bay-0`. A
   fresh full pgBackRest backup was started automatically, because a
   point-in-time restore starts a new timeline. Delete `<work-dir>` once
   satisfied.
   - If the bay did not become healthy, the backup timers are left stopped
     (listed in `<work-dir>/stopped-timers`), so nothing backs up a broken
     bay; start them once it is healthy.
   - Exit status 2 means the bay is up but the full backup could not be
     started; start `cocalc-bay-pgbackrest-backup@full.service` by hand.
   - Deletions recorded after the recovery point (accounts, projects,
     data-subject requests) are not in the restored database. Deletion replay
     is not automated yet: list them from the support/admin records and
     reapply them before telling users the site is back, as the Data
     Management Policy requires.

**To undo a cutover:** stop the bay (`sudo systemctl stop cocalc-bay.target`),
move `/mnt/cocalc/bays/bay-0/{postgres,sync}` aside, move
`<work-dir>/pre-restore/{postgres,sync}` back, and start it again (`sudo
systemctl start cocalc-bay.target`).

Project hosts keep running throughout, but users cannot reach the site while
the bay is down. After a restore to an earlier time, the database may not know
about projects or files created after the target; that state still exists on
the hosts and in project backups.

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

3. **Prepare the host** from a checkout of the release the old bay ran. The
   public deployment index lists every bay deployment with its artifact and
   commit; take the newest one whose status is `succeeded`:

   ```sh
   curl -fsS https://software.cocalc.ai/software/deployments/prod/bay/index.json |
     python3 -c 'import json, sys
   d = next(d for d in json.load(sys.stdin)["deployments"] if d["status"] == "succeeded")
   print(d["artifact_id"], d["git"]["commit"])'
   ```

   ```sh
   git clone https://github.com/sagemathinc/cocalc-ai.git && cd cocalc-ai
   git checkout <commit>
   # The restore tooling comes from current main, whatever release is
   # restored: an older release may lack the fence (step 4).
   git worktree add ../restore-tools origin/main
   sudo ./src/scripts/bay-systemd/bay-bootstrap-host.sh --install-nodejs
   sudo chown cocalc-bay:cocalc-bay /mnt/cocalc-backups
   ```

   This creates the `cocalc-bay` user and installs the runtime libraries.
   PostgreSQL writes its local backups to `/mnt/cocalc-backups`, and does not
   start until the bay account owns it.

4. **Fence the new bay, and install the master key** (from the human, as a
   file). The release installed in step 6 enables the bay's units, including
   the production tunnel, so that it comes up at boot. The fence (see "How
   the restore works") keeps all of it down, across reboots, until the
   cutover in step 8 has put restored data in place. It is installed from
   current main, with the restore tooling, before any release: releases
   older than the fence have neither its drop-ins nor a `bay-restore` that
   lifts it, and installing them leaves both in place:

   ```sh
   sudo ../restore-tools/src/scripts/bay-systemd/install-restore-tools.sh --fence
   sudo install -o root -g root -m 0600 ./site-master-key /etc/cocalc/site-master-key
   ```

5. **Recover the configuration and secrets from the escrow.** The bay seals
   `/etc/cocalc/*.env` and its secrets directory into R2 daily
   (`cocalc-bay-config-escrow.timer`). The bay's own R2 keys are inside the
   escrow, so fetching it needs separate read access: the read-only R2 token
   kept in 1Password next to the master key (or one minted with the
   Cloudflare login).

   ```sh
   # The keys reach curl on stdin, never on a command line.
   printf 'user = "%s:%s"\n' "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" |
     sudo sh -c 'umask 077; curl --config - --aws-sigv4 aws:amz:auto:s3 --fail \
       --max-filesize 8388608 -o /root/bay-config.v1.json "$1"' sh \
       "$R2_ENDPOINT/$R2_BUCKET/cocalc-escrow/bay-0/bay-config.v1.json"
   NODE="$(ls /opt/cocalc/nvm/versions/node/*/bin/node | tail -1)"   # from step 3
   sudo "$NODE" src/scripts/bay-systemd/libexec/bay-config-escrow.mjs info \
     --in /root/bay-config.v1.json --master-key /etc/cocalc/site-master-key
   # The parent of each destination must exist; open creates the secrets
   # directory itself with its recorded owner and mode.
   sudo install -d -m 0755 /mnt/cocalc/bays
   sudo install -d -o cocalc-bay -g cocalc-bay -m 0755 /mnt/cocalc/bays/bay-0
   sudo "$NODE" src/scripts/bay-systemd/libexec/bay-config-escrow.mjs open \
     --master-key /etc/cocalc/site-master-key --in /root/bay-config.v1.json --chown \
     --map etc-cocalc=/etc/cocalc --map bay-secrets=/mnt/cocalc/bays/bay-0/secrets
   ```

   `info` shows when it was sealed; dated copies from the last 30 days are
   under `cocalc-escrow/bay-0/history/` if an older one is needed. A wrong
   master key is reported as such. `open` never follows a symbolic link in a
   destination and refuses to overwrite existing files without `--force`.
   `/mnt/cocalc/bays` stays root-owned: the restore's work directory goes
   there.

6. **Install the release** without starting it (the escrowed env files are
   kept; only missing ones are generated). Use the published bay bundle of
   the artifact from step 3, checked against the SHA-256 in its manifest.
   The release installs its own `bay-restore` in
   `/usr/local/libexec/cocalc-bay`, so install the restore tooling from
   current main again afterwards:

   ```sh
   A=https://software.cocalc.ai/software/artifacts/bay/<artifact_id>
   curl -fsS -o /tmp/cocalc-bay-runtime-linux-x64.tar.xz "$A/files/cocalc-bay-runtime-linux-x64.tar.xz"
   curl -fsS "$A/manifest.json" | python3 -c 'import json, sys
   print(json.load(sys.stdin)["files"][0]["sha256"], " /tmp/cocalc-bay-runtime-linux-x64.tar.xz")' |
     sha256sum -c
   # Releases that know the fence refuse to install on a fenced bay without
   # --fenced; older ones do not know the option.
   FENCED=""
   grep -q -- '--fenced)' ./src/scripts/bay-systemd/bay-bootstrap-release.sh && FENCED=--fenced
   sudo ./src/scripts/bay-systemd/bay-bootstrap-release.sh $FENCED --bundle /tmp/cocalc-bay-runtime-linux-x64.tar.xz
   sudo ../restore-tools/src/scripts/bay-systemd/install-restore-tools.sh
   ```

   (`--source "$PWD/src"` works too, but needs a full build of the checkout
   first; see README.md, "Fresh VM Bootstrap").

7. **Install the backup tools** the restore needs:

   ```sh
   ./src/scripts/bay-systemd/build-pgbackrest.sh --install-deps --output /tmp/pgbackrest
   sudo install -m 0755 /tmp/pgbackrest /usr/local/bin/pgbackrest
   curl -fsSL https://github.com/sagemathinc/rustic/releases/download/v0.11.1/rustic-v0.11.1-linux-x86_64.tar.gz |
     sudo tar -xz -C /usr/local/bin rustic
   ```

8. **Make sure the old bay cannot come back, then restore and start the
   bay.** The new VM runs the same Cloudflare tunnel as the old one, with the
   same credentials. If both run it, Cloudflare spreads requests over two
   separate bays, and both write to the same backup repository. Seeing no
   tunnel connectors right now is not enough: GCP restarts a VM that went
   down with its host or zone, and the old bay then reconnects. One of these
   must hold before you go on:
   - **The old VM is stopped or deleted, confirmed through the API.** A
     stopped VM stays stopped:

     ```sh
     gcloud compute instances stop prod-bay-0 --project=projecthosts --zone=us-south1-a
     gcloud compute instances describe prod-bay-0 --project=projecthosts \
       --zone=us-south1-a --format='value(status)'   # must print TERMINATED
     ```

   - **If it cannot be reached (its zone is down), its credentials are
     revoked.** It would come back with everything it had. With the human,
     who has the Cloudflare login:
     - revoke the bay's R2 tokens (R2 > Manage API tokens), create new ones
       scoped to the bucket, and put them in `/etc/cocalc/bay-secrets.env` on
       the new VM;
     - revoke the Cloudflare API token the bay uses for its tunnel (server
       setting "Project Hosts: Cloudflare Tunnel - API Token"), create a new
       one with the same permissions, and add it to
       `/etc/cocalc/bay-secrets.env` as
       `COCALC_SETTING_PROJECT_HOSTS_CLOUDFLARE_TUNNEL_API_TOKEN=<token>`
       (the hubs store it at start; remove the line afterwards, as it keeps
       the setting read-only);
     - delete the tunnel (Zero Trust > Networks > Tunnels, `hub-<hostname>`).
       The new bay creates a new one and points DNS at it, and the old
       tunnel secret no longer works;
     - replace the host-owner SSH key: trust a new key on the project hosts
       and remove the old public key (README.md, "Rotation").

     Then rotate the rest as in step 10. Stop or delete the old VM as soon as
     its zone is back.

   Then:

   ```sh
   sudo /usr/local/libexec/cocalc-bay/bay-restore restore --latest --yes
   ```

   This restores PostgreSQL to the newest archived transaction and Conat to
   its newest snapshot, moves any freshly initialized data aside, and starts
   the bay, with the frontdoor and the tunnel (enabled bay services outside
   `cocalc-bay.target`). Traffic reaches the new VM through the Cloudflare
   tunnel, whose credentials came from the escrow; DNS does not change. The
   cutover lifts the fence from step 4. If the restore fails, or with
   `--no-cutover`, the fence stays and the bay stays down, after a reboot
   too: the new VM's empty bay never takes traffic.

9. **Afterwards:**
   - confirm the site works;
   - enable the backup timers listed in README.md ("Activation Order") and
     `cocalc-bay-config-escrow.timer`;
   - keep the old VM stopped; delete it and its disks once you are satisfied;
   - run a disposable drill:
     `cocalc bay restore-test bay-0 --disposable-gcp`. The new VM has no
     record of a SQLite backup yet, so the drill refuses to run until the
     first one has finished; start it with
     `sudo systemctl start cocalc-bay-sqlite-backup.service`;
   - replay deletions as in mode A, step 4.
10. **Rotate the live credentials** the escrow contained, as described under
    "Rotation" in README.md ("Configuration Escrow"): the escrow was opened,
    so treat its contents as exposed.

## Testing this procedure

- The weekly disposable drill runs the engine against the real backups (see
  "How the restore works" for what it does and does not cover).
- `libexec/bay-restore-cutover.test.sh` (needs sudo) runs `bay-restore` with a
  fake systemd and engine. It checks that:
  - the bay is stopped, and its processes are gone, before the engine runs;
  - the bay restarts on its old data after a failure or with `--no-cutover`;
  - the cutover order, the unhealthy case and the backup warning are right;
  - the bay is fenced while the engine runs; the cutover, a failed restore
    and `--no-cutover` lift the fence, except one that was there before the
    restore; a stop that fails lifts the fence it set;
  - on a fresh VM the enabled frontdoor and tunnel start with the restored
    bay, and stay down after a failure or with `--no-cutover`;
  - `--target-time` keeps its microseconds.
- `libexec/bay-restore-engine.test.sh` checks the engine's PITR sentinel
  verdict, and that a missed target fails the drill at once.
- `install-scaffold.test.sh` checks that the fence's drop-ins are installed
  for every bay unit; `bay-bootstrap-release.test.sh` that a fenced bay takes
  no deploy except a `--fenced` install, and never `--start`.
  - copies and work directories the bay account could change are refused.
- `test/bay-restore-e2e.sh` runs `bay-restore` end to end on a disposable
  Ubuntu 24.04 VM against a local TLS S3 server: a point-in-time restore, a
  cutover, and a restore of the latest state.
- `libexec/bay-config-escrow.test.sh` tests the escrow.
