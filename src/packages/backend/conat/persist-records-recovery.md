# Recovering the persist's durability records after a failed set-up

Finding 028, ALT-D2, ops0's S4 ruling.

**Scope.** A bay or a project host whose persist refuses disk-backed streams because this boot's records root could not be set up. Documents on that host cannot be saved until this is done; ephemeral streams still run. There is no automated repair.

**The command.** `persist-records-recover` is a command of the project-host entry (`project-host/persist-records-recover-cli.ts`, dispatched first in `main.ts`). It therefore ships in every artifact that runs a persist:

| Role | Command (dry run; add `--apply` to remove) | Runs as | Units to stop and start |
|---|---|---|---|
| Project host | `/opt/cocalc/project-host/bin/project-host persist-records-recover` | the project-host runtime user (`stat -c %U /mnt/cocalc/data`) | `cocalc-project-host-watchdog.timer`, `cocalc-project-host-watchdog.service`, `cocalc-project-host-start.service` (its stop runs `ctl stop`, which stops the daemon, its conat-persist child and its file server) |
| Bay | `"$COCALC_BAY_NODE_BIN" "$COCALC_BAY_PROJECT_HOST_MAIN" persist-records-recover`, with the bay env loaded (below) | `cocalc-bay` | `cocalc-bay-conat-persist.service` |

**Notes on the command:**
- On a project host, `bin/project-host` is the wrapper the bootstrap writes. It runs the installed node on the current bundle's entry, whatever the bundle layout.
- The command loads the daemon's env files (`/etc/cocalc/project-host.env`, `project-host.local.env`) itself.
- On a bay, `COCALC_BAY_PROJECT_HOST_MAIN` is the persist's own entry (`/opt/cocalc/bay/current/runtime/project-host/index.js` in a rocket bundle). In a source-overlay bay it is set in `bay-current-cocalc-overlay.env`.
- The command resolves every path from the role's environment, exactly as the persist does, and prints them: never type them by hand.

**The rules:**
- Never run any step as root, and never create any of these paths by hand. The persist creates them itself, 0700, as its user; a root-created path makes it refuse again (T1).
- The command only removes these, by name:
  - this boot's `records/<boot id>/sentinel.json`;
  - its empty `dirty/`, `poisoned-file/` and `poisoned-project/` directories, then the boot dir itself;
  - the set-up's temp files;
  - `<base>/marker.json`, `<state>/records-marker.json`, and `<state>/records-migrated.json` LAST.
- It never touches the post-reboot records (`<state>/poisoned/`) or the legacy `/run/cocalc-persist` (both only checked).

## Steps

1. **The refusal is this case.** The persist logged `PERSIST ALERT (page): the durability records root is refused`, and its diagnostics (`durability.startup_records.records_code`) show one of:
   - `records_write_failed`;
   - `marker_copies_differ`;
   - `marker_copy_missing`;
   - `marker_missing`;
   - `boot_dir_unexpected`.

   Anything else stops here and is escalated. That includes `records_root_replaced`: this boot's records dir was changed after its set-up completed, and records may be lost.
2. **The disk is healthy.** Free space, or repair the fault, until writes in the base and the state dir succeed.
3. **Stop every user of the records:**
   - project host:
     ```
     sudo systemctl stop cocalc-project-host-watchdog.timer cocalc-project-host-watchdog.service cocalc-project-host-start.service
     ```
     Stop the timer first, or it starts the daemon again within a minute.
   - bay:
     ```
     sudo systemctl stop cocalc-bay-conat-persist.service
     ```
4. **Check nothing runs:**
   - project host: `pgrep -af '/opt/cocalc/project-host/'` and `systemctl is-active cocalc-project-host-watchdog.timer` (must be `inactive`);
   - bay: `systemctl is-active cocalc-bay-conat-persist.service` (must be `inactive`).
5. **Dry run, as the persist user.**
   - project host:
     ```
     sudo -u "$(stat -c %U /mnt/cocalc/data)" /opt/cocalc/project-host/bin/project-host persist-records-recover
     ```
   - bay:
     ```
     sudo -u cocalc-bay bash -c 'set -a; . /etc/cocalc/bay.env; for f in bay-workers bay-overlay bay-topology bay-local; do [ -r /etc/cocalc/$f.env ] && . /etc/cocalc/$f.env; done; set +a; exec "$COCALC_BAY_NODE_BIN" "$COCALC_BAY_PROJECT_HOST_MAIN" persist-records-recover'
     ```
   - It prints JSON with `base`, `stateDir`, `bootId`, `shape` (the partial set-up it found, e.g. `boot dir present; sentinel present; marker A another boot; marker B this boot (copies differ); migration flag present`) and `plan`. Check that `base` and `stateDir` are the role's paths.
   - `"ok": false` means it removed nothing. Read `stop`:
     - `records of this boot are present`: do **not** remove them. Reboot the host; after a reboot they belong to another boot and the persist ignores them, together with the page cache they describe. Start again at step 1.
     - `not a failed creation`: this boot's set-up completed. If it was changed afterwards, reboot first, as above. If it is intact, nothing here is broken: escalate.
     - anything else (`unlisted entry`, `not a regular file`, `not a real directory`, `owned by uid`, `run this as the persist user`, `legacy records check`): escalate. Do not delete anything by hand.
6. **Check again that nothing runs** (step 4).
7. **Apply:** the same command with `--apply`.
   - It removes everything but the migration flag, makes that durable (fsync of the directories), then removes the flag.
   - `"ok": true` lists every removal in `applied`.
   - `"ok": false` with `partial apply: N of M removed, then <step> failed (<error>); now: <shape>; re-run this tool, or escalate`:
     - `applied` lists what was removed, and `now:` is the state found after the failure.
     - Do not start anything yet. Depending on the shape and the point of failure, the persist could already create the root again at its next start, without the removals being durable.
     - Fix the cause and run step 7 again. If it fails again, escalate.
8. **Start every unit you stopped:**
   - project host: `sudo systemctl start cocalc-project-host-start.service cocalc-project-host-watchdog.timer`;
   - bay: `sudo systemctl start cocalc-bay-conat-persist.service`.
9. **Check durable mode.**
   - The diagnostics show `startup_records.records_ok: true`, `records_t1: "pass"`, `records_migrated: true`, and `records_root` = `<base>/records/<the current boot id>`.
   - A document on that host saves.
   - If the persist refuses again, read the new code (step 1) and escalate. Never repeat blindly.

**Tests:**
- in `backend/conat/test/persist/records-root-gate.test.ts`:
  - `[RECOVERY]`;
  - `[RECOVERY-stop]`;
  - `[RECOVERY-S5]`;
  - `[RECOVERY-B5]`;
  - `[RECOVERY-ORDER]`;
  - `[RECOVERY-FSYNC]`;
- in `records-recover-report.test.ts`: `[RECOVERY-REPORT]`, the report complete through a slow pipe;
- in `project-host/persist-records-recover-cli.test.ts`: `[RECOVERY-CLI]`, the command with an env file as the daemon reads it, and `[RECOVERY-CLI-main]`.
- The built artifact (bay and project host) is checked at build time and on staging2 (ops0's ruling).
