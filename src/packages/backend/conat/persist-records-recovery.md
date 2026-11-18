# Recovering the persist's durability records after a failed set-up

Finding 028, ALT-D2. This runbook is for a bay or a project host whose persist refuses disk-backed streams because the records root could not be set up. It does not cover other refusals. The tool it uses is `persist-records-recover.js`, built from `persist-records-recover.ts` next to this file. The tests run exactly these steps in `records-root-gate.test.ts`: `[RECOVERY]` and `[RECOVERY-stop]`.

**What happened.** The persist keeps its records in `<base>/records/<boot id>/`. It creates that directory, a sentinel and a marker in two copies:
- copy A: `<base>/marker.json`;
- copy B: `<state>/records-marker.json`.

On a first start with this code it also writes `<state>/records-migrated.json`. If the disk fails or is full while it writes these, the state is partial. The persist then refuses disk streams for the rest of the boot: documents on that host cannot be saved, while ephemeral streams still run. It does not repair this by itself. An operator does, with the steps below.

**Where things are:**

| Role | Base | State dir (copy B) | Runs as | Every process that uses the records |
|---|---|---|---|---|
| Bay | `${COCALC_BAY_STATE_DIR}/persist-durability` | `${COCALC_SYNC:-$BAY_ROOT/sync}/.cocalc-persist-state` (or `COCALC_PERSIST_STATE_DIR`) | the bay account (`cocalc-bay`) | `cocalc-bay-conat-persist.service` |
| Project host | `${COCALC_DATA}/persist-durability` | `${COCALC_DATA}/sync/.cocalc-persist-state` (or `COCALC_SYNC` / `COCALC_PERSIST_STATE_DIR`) | the owner of `${COCALC_DATA}` (`stat -c %U "$COCALC_DATA"`) | the project-host daemon: its conat-persist child AND its file server (persist-storage maintenance). Stop the whole daemon, not only the persist child. |

Do not type these paths by hand. The tool resolves them from the role's environment, exactly as the persist does, and prints them.

## Steps

1. **Confirm this is the case.**
   - The persist logged `PERSIST ALERT (page): the durability records root is refused`.
   - Its diagnostics show `durability.startup_records.records_code` as one of: `records_write_failed`, `marker_copies_differ`, `marker_copy_missing`, `marker_missing`, `boot_dir_unexpected`, `records_root_replaced`.
   - Any other code (`t1_failed`, `records_root_project_visible`, `legacy_records_present`, `boot_id_invalid`, …) is a different problem: stop and escalate.
2. **Fix the disk first.** Free space or repair the fault, until writes in the base and the state dir succeed.
3. **Stop every process that uses the records** (table above).
   - Bay: `systemctl stop cocalc-bay-conat-persist`.
   - Project host: stop the project-host daemon (its service), which stops the persist child and the file server.
   - Confirm none is left: `pgrep -u <persist user> -af 'conat-persist|project-host'` prints nothing for that role.
   - Each of these processes caches its refusal, so restarting only one of them is not enough.
4. **Dry run, as the persist user, with the persist's environment.**
   - Never run it as root.
   - Never create any of these paths by hand: the persist creates them itself, 0700, as its own user. A directory created by root makes the persist refuse again (T1).
   - Bay:
     ```
     sudo -u cocalc-bay bash -c 'set -a; . /etc/cocalc/bay.env; for f in bay-overlay bay-topology bay-local; do [ -r /etc/cocalc/$f.env ] && . /etc/cocalc/$f.env; done; set +a; exec "$COCALC_BAY_NODE_BIN" /opt/cocalc/bay/current/<backend dist>/conat/persist-records-recover.js'
     ```
   - Project host: the same, as the owner of `${COCALC_DATA}`, with `/etc/cocalc/project-host.env` (and `project-host.local.env` if present) and the host's node.
   - It prints JSON: `base`, `stateDir`, `bootId` and the `plan` (the exact paths it would remove).
   - With `"ok": false` it removed nothing; read `stop`:
     - `records of this boot are present`: **do not remove them**. Reboot the host: after a reboot they belong to another boot and the persist ignores them, together with the page cache they describe. Then run step 4 again.
     - `unlisted entry …`, `not a regular file`, `owned by uid …`, `run this as the persist user`, `legacy records check …`: stop and escalate. Do not delete anything by hand.
5. **Check the plan.** It may contain only:
   - this boot's `records/<boot id>/sentinel.json` (and its `.sentinel.json.*.tmp`);
   - its empty `dirty/`, `poisoned-file/` and `poisoned-project/` directories, then the boot dir itself;
   - `<base>/marker.json`, `<state>/records-marker.json`, `<state>/records-migrated.json` and their `.*.tmp` files.
   
   It never contains `<state>/poisoned/*` (the post-reboot records, always kept), other boots' directories (the persist prunes those itself), or the legacy `/run/cocalc-persist` (only checked).
6. **Apply.** Run the same command with `--apply`. It prints `"applied": true`.
7. **Start every process you stopped**, then check:
   - the diagnostics show `startup_records.records_ok: true`, `records_t1: "pass"`, `records_migrated: true`, and `records_root` = `<base>/records/<the current boot id>`;
   - opening a document on that host saves (a disk stream opens).
   - If the persist refuses again, do not repeat the steps blindly: read the new code (step 1) and escalate.
