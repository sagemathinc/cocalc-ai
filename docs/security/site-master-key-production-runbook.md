# Site Master Key Production Runbook

Date: 2026-05-14

Status: first production runbook for `SEC-MASTER-001`.

## Purpose

CoCalc production bays use exactly one site master key, named
`site-master-key`. Purpose-specific encryption keys are derived from it for:

- encrypted site/server settings.
- project backup repository secrets.
- project secrets.

This key is required to decrypt encrypted operational data. Database, disk, and
R2 backups are not sufficient without it.

## Scope

This runbook applies to the hosted `cocalc.ai` multi-bay production deployment.

It assumes:

- bays run on dedicated Linux VMs under `systemd`.
- bay services load `/etc/cocalc/site-master-key` through systemd
  `LoadCredential=`.
- production services set `COCALC_REQUIRE_SITE_MASTER_KEY=1`.
- a human operator stores an encrypted backup in 1Password or equivalent
  off-host secret storage.

Launchpad and local development can use the same CLI lifecycle commands, but
their provisioning details are intentionally not release blockers for hosted
production.

## Security Rules

- There is one site master key per CoCalc deployment, not one per bay.
- Every bay in the same deployment must use the same key.
- Never commit the key or its backup to git.
- Never paste the raw key into chat, tickets, logs, shell history, or docs.
- Store the encrypted backup and its passphrase in separate 1Password fields or
  separate 1Password items.
- Treat a lost key as data loss for encrypted settings, backup repository
  passwords, and project secrets.
- Treat a leaked key as a full encrypted-secret compromise and rotate affected
  downstream secrets.

## Files

Production permanent key file:

```text
/etc/cocalc/site-master-key
```

Expected permissions:

```text
owner: root
mode: 0600
```

Systemd credential name:

```text
site-master-key
```

Required production environment:

```sh
COCALC_REQUIRE_SITE_MASTER_KEY=1
```

Preferred systemd unit directive:

```ini
LoadCredential=site-master-key:/etc/cocalc/site-master-key
```

The application reads the credential from `CREDENTIALS_DIRECTORY` when systemd
provides it. This keeps the service path read-only from the process point of
view and makes missing production keys fail closed.

Key-path selection in `cocalc admin master-key` is local; `status` and
`doctor --files-only` do not query a running bay. An interactive shell does not
inherit a systemd service's
`CREDENTIALS_DIRECTORY`. Use an explicitly selected key path for shell checks,
and inspect the service configuration and logs separately to verify loading.

The temporary provisioning and restore examples below assume a shell without
`CREDENTIALS_DIRECTORY`, `COCALC_SITE_MASTER_KEY_PATH`,
`COCALC_SECRET_SETTINGS_KEY_PATH`, or `SECRETS` overrides. Those settings can
take precedence over the `COCALC_DATA_DIR` used for staging.

## Initial Production Key Creation

Do this once, before creating production data that depends on encrypted
settings or encrypted backup repository secrets.

Pick one secure admin workstation or disposable provisioning host. Do not
generate independent keys on each bay.

Create a temporary local data directory:

```sh
export COCALC_KEY_WORKDIR="$(mktemp -d)"
mkdir -p "$COCALC_KEY_WORKDIR/source" "$COCALC_KEY_WORKDIR/backup"
```

Create a strong backup passphrase. Store it in 1Password. For the CLI command,
place it temporarily in a private file:

```sh
umask 077
printf '%s\n' 'REPLACE_WITH_1PASSWORD_GENERATED_PASSPHRASE' \
  > "$COCALC_KEY_WORKDIR/passphrase.txt"
```

Generate the key:

```sh
COCALC_REQUIRE_SITE_MASTER_KEY=0 \
  COCALC_DATA_DIR="$COCALC_KEY_WORKDIR/source" \
  cocalc admin master-key init
```

The temporary initialization command permits key creation only in this provisioning
shell. Keep `COCALC_REQUIRE_SITE_MASTER_KEY=1` in production services.

Verify:

```sh
COCALC_DATA_DIR="$COCALC_KEY_WORKDIR/source" \
  cocalc admin master-key status

stat -c '%a %U %G %n' \
  "$COCALC_KEY_WORKDIR/source/secrets/site-master-key"
```

Expected:

- `site_master_key.exists=true`
- `site_master_key.key_valid=true`
- `site_master_key.mode="0600"`
- `backup_required=true`
- local file mode is `600`

Export an encrypted backup:

```sh
COCALC_DATA_DIR="$COCALC_KEY_WORKDIR/source" \
  cocalc admin master-key export \
  "$COCALC_KEY_WORKDIR/backup/site-master-key-backup.json" \
  --passphrase-file "$COCALC_KEY_WORKDIR/passphrase.txt"
```

Verify the backup file:

```sh
stat -c '%a %n' "$COCALC_KEY_WORKDIR/backup/site-master-key-backup.json"
node -e '
  const fs = require("fs");
  const backup = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (backup.encrypted !== true) throw Error("backup is not encrypted");
  if (backup.key != null) throw Error("backup contains plaintext key field");
  console.log({ encrypted: backup.encrypted, kind: backup.kind, version: backup.version });
' "$COCALC_KEY_WORKDIR/backup/site-master-key-backup.json"
```

Expected:

- backup file mode is `600`.
- `encrypted` is `true`.
- no plaintext `key` field exists.

Store in 1Password:

- item title: `cocalc.ai site-master-key backup`.
- attachment: `site-master-key-backup.json`.
- field: backup passphrase.
- field: creation date.
- field: source key SHA-256 from `cocalc admin master-key status`.

Do not store the unencrypted temporary source directory as the backup. Delete the
temporary working directory after provisioning and restore verification:

```sh
rm -rf "$COCALC_KEY_WORKDIR"
unset COCALC_KEY_WORKDIR
```

## Provisioning a Bay

For each production bay VM, copy the same raw key to
`/etc/cocalc/site-master-key`.

From the provisioning host:

```sh
scp "$COCALC_KEY_WORKDIR/source/secrets/site-master-key" \
  root@BAY_HOST:/etc/cocalc/site-master-key
```

On the bay:

```sh
sudo chown root:root /etc/cocalc/site-master-key
sudo chmod 600 /etc/cocalc/site-master-key
```

Verify systemd units include the credential and fail-closed environment. The
exact unit names may vary, but every service that reads encrypted settings or
project backup secrets must inherit these properties:

```sh
sudo systemctl cat cocalc-bay-hub@1.service | rg 'LoadCredential|COCALC_REQUIRE_SITE_MASTER_KEY'
```

Expected:

```ini
LoadCredential=site-master-key:/etc/cocalc/site-master-key
Environment=COCALC_REQUIRE_SITE_MASTER_KEY=1
```

Start or restart the bay services:

```sh
sudo systemctl daemon-reload
sudo systemctl restart cocalc-bay.target
```

After startup, check the installed key from an operator shell on the bay with
the CLI available to `sudo`:

```sh
sudo env -u CREDENTIALS_DIRECTORY \
  COCALC_SITE_MASTER_KEY_PATH=/etc/cocalc/site-master-key \
  cocalc admin master-key status
sudo env -u CREDENTIALS_DIRECTORY \
  COCALC_SITE_MASTER_KEY_PATH=/etc/cocalc/site-master-key \
  cocalc admin master-key doctor --files-only
```

Expected for these explicit shell checks:

- key source is `environment`, with path `/etc/cocalc/site-master-key`.
- key is readable and valid.
- permissions are private.

`systemd-credential` is the source only when the checking process receives the
service's credential environment. Matching the shell checks does not prove
that a running service loaded the key; also inspect the units and ensure there
are no credential or missing-key errors in `journalctl`.

Check logs:

```sh
sudo journalctl -u 'cocalc-bay-*' --since '10 minutes ago' \
  | rg -i 'site master key|required but missing|invalid master key|credential'
```

Expected:

- no `required but missing`.
- no invalid key length.
- no credential load failures.

## Multi-Bay Verification

Compare the SHA-256 of the installed key file on every bay:

```sh
sudo env -u CREDENTIALS_DIRECTORY \
  COCALC_SITE_MASTER_KEY_PATH=/etc/cocalc/site-master-key \
  cocalc admin master-key status | jq -er '.site_master_key.sha256 | select(type == "string" and length == 64)'
```

Require each command to succeed; stop on a missing or invalid fingerprint.
The validated 64-character fingerprints must match across all production bays.
This verifies the
selected local key files, not the credentials already loaded by running
processes; complete the service and log checks on every bay too.

If any bay differs:

1. Stop that bay before it writes new encrypted values.
2. Replace `/etc/cocalc/site-master-key` with the correct deployment key.
3. Restart the bay.
4. Re-run `status` and `doctor --files-only`.

Do not let a bay with the wrong key remain in service.

## Disaster Restore After Host Loss

Use this when a bay VM or disk is lost and must be rebuilt from infrastructure
plus backups.

Inputs required:

- R2/database/bay backup artifacts.
- 1Password item containing `site-master-key-backup.json`.
- backup passphrase.
- deployment config for the bay.

On a secure restore host, stage the backup and passphrase:

```sh
umask 077
mkdir -p /root/cocalc-restore
cp /secure/path/site-master-key-backup.json /root/cocalc-restore/
printf '%s\n' 'REPLACE_WITH_1PASSWORD_PASSPHRASE' \
  > /root/cocalc-restore/site-master-key-passphrase.txt
```

Restore the key into a staging data dir first:

```sh
mkdir -p /root/cocalc-restore/key-restore
COCALC_DATA_DIR=/root/cocalc-restore/key-restore \
  cocalc admin master-key import \
  /root/cocalc-restore/site-master-key-backup.json \
  --passphrase-file /root/cocalc-restore/site-master-key-passphrase.txt
```

Verify:

```sh
COCALC_DATA_DIR=/root/cocalc-restore/key-restore \
  cocalc admin master-key status
```

Install:

```sh
sudo mkdir -p /etc/cocalc
sudo install -o root -g root -m 0600 \
  /root/cocalc-restore/key-restore/secrets/site-master-key \
  /etc/cocalc/site-master-key
```

Then restore the bay data from normal bay backup procedures and start services:

```sh
sudo systemctl daemon-reload
sudo systemctl restart cocalc-bay.target
```

Verify after restore:

```sh
sudo env -u CREDENTIALS_DIRECTORY \
  COCALC_SITE_MASTER_KEY_PATH=/etc/cocalc/site-master-key \
  cocalc admin master-key doctor --files-only
sudo env -u CREDENTIALS_DIRECTORY \
  COCALC_SITE_MASTER_KEY_PATH=/etc/cocalc/site-master-key \
  cocalc admin master-key status | jq -er '.site_master_key.sha256 | select(type == "string" and length == 64)'
sudo journalctl -u 'cocalc-bay-*' --since '30 minutes ago' \
  | rg -i 'site master key|required but missing|invalid master key|decrypt|credential'
```

Expected:

- doctor is OK except for expected backup warning.
- key SHA-256 matches the 1Password-recorded SHA-256.
- logs show no missing/invalid key errors.
- encrypted site settings can be read.
- project backup repository secrets can be used.
- a newly started test project mounts its configured secrets correctly.

## Fail-Closed Test

Use this on disposable hosts only. It intentionally verifies that production
does not auto-create a fresh key.

Stop bay services:

```sh
sudo systemctl stop cocalc-bay.target
```

Move the key away:

```sh
sudo mv /etc/cocalc/site-master-key /etc/cocalc/site-master-key.disabled
```

Attempt startup:

```sh
sudo systemctl start cocalc-bay.target
```

Expected:

- services that need the key fail.
- logs include `site master key is required but missing` or systemd credential
  load failure.
- no new key is created.

Restore the key:

```sh
sudo mv /etc/cocalc/site-master-key.disabled /etc/cocalc/site-master-key
sudo chown root:root /etc/cocalc/site-master-key
sudo chmod 600 /etc/cocalc/site-master-key
sudo systemctl restart cocalc-bay.target
```

## Migration From Legacy Two-Key Dev Sites

This section applies only to the pre-release dogfood/dev sites that existed
before the one-key model.

Run a dry-run first:

```sh
cocalc admin master-key doctor
cocalc admin master-key migrate
```

If the report is clean and you are ready for the offline write:

1. Stop CoCalc services, or in dev/launchpad where Postgres is coupled to the
   service lifecycle, ensure no user traffic and plan an immediate full restart.
2. Run:

```sh
cocalc admin master-key migrate --execute --yes-i-stopped-cocalc
```

3. Restart CoCalc immediately.
4. Verify:

```sh
cocalc admin master-key doctor
cocalc admin master-key status
```

After the three known pre-release sites are migrated and verified, consider
deleting the one-time migration scaffolding if it is no longer needed.

## Rotation Policy

Routine rotation is not part of the first public release.

If rotation is ever needed:

- treat it as an offline operation.
- stop all CoCalc services that can read/write encrypted data.
- take a fresh backup before starting.
- re-encrypt every purpose-specific encrypted payload under the new key.
- verify all bays receive the new key before restarting.
- keep the old encrypted backup until restore testing proves the new key works.

Do not attempt online rotation without a separate design and migration plan.

## Operator Checklist

Before launch:

- [ ] One production `site-master-key` exists.
- [ ] Encrypted backup file is in 1Password.
- [ ] Backup passphrase is in 1Password.
- [ ] Key SHA-256 is recorded in 1Password.
- [ ] Every bay has `/etc/cocalc/site-master-key` with owner `root:root` and
      mode `0600`.
- [ ] Every bay systemd unit that needs secrets has
      `LoadCredential=site-master-key:/etc/cocalc/site-master-key`.
- [ ] Every production bay process has `COCALC_REQUIRE_SITE_MASTER_KEY=1`.
- [ ] The explicit installed-key status checks above succeed and report the same validated
      SHA-256 on every bay; service configuration and logs confirm key loading.
- [ ] The explicit installed-key `doctor --files-only` checks above are clean
      on every bay, except for the expected “software cannot verify backup”
      warning.
- [ ] A disposable-host restore test has restored the encrypted backup and
      matched the recorded key SHA-256.
