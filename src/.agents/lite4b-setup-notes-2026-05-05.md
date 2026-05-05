# lite4b setup notes

These are the concrete operational facts for working on the `lite4b` dev setup.

## Control plane

- Load hub admin env before using the CoCalc CLI:
  - `cd /home/user/cocalc-ai/src`
  - `eval "$(pnpm -s dev:hub:env)"`
- In this setup, the local dev hub at `http://localhost:9100` is fronted by public Cloudflare at:
  - `https://lite4b.cocalc.ai`
- The public software endpoint is therefore:
  - `https://lite4b.cocalc.ai/software`

## Browser / UI

- The UI button labeled `Deploy hub latest` is the normal working path for rolling a host onto the bundle currently advertised by the hub's `/software` endpoint.
- CLI equivalent I used:
  - `cd /home/user/cocalc-ai/src`
  - `eval "$(pnpm -s dev:hub:env)"`
  - `node packages/cli/dist/bin/cocalc.js host upgrade host4 --artifact project-host --align-runtime-stack --base-url https://lite4b.cocalc.ai/software --wait`
- If the current shell already has the dev hub env loaded and `cocalc` on `PATH`, the same command is:
  - `cocalc host upgrade host4 --artifact project-host --align-runtime-stack --base-url https://lite4b.cocalc.ai/software --wait`
- The local hub restart is not instant:
  - it stops and starts the primary hub
  - it also restarts `bay-1`
  - it also restarts `bay-2`
- Treat a hub restart as a 3-bay cycle, not a single-process restart.

## SSH access

- This container can SSH directly to the dev GCP hosts because its public key is authorized in that GCP project.
- Examples:
  - `ssh ubuntu@34.174.128.8` for `host1`
  - `ssh ubuntu@34.17.5.17` for `italy`
  - `ssh ubuntu@34.174.123.127` for `host4`

## Software artifacts

- The hub serves `project-host latest` from the local packages tree.
- The route is implemented in:
  - `src/packages/hub/servers/app/project-host-software.ts`
- The `latest` project-host version comes from:
  - `src/packages/project-host/build/bundle/build-identity.json`
- Building the bundle alone is not enough if the hub has cached stale build identity information.
- The working deploy flow is:
  1. `pnpm -C /home/user/cocalc-ai/src tsc`
  2. `cd /home/user/cocalc-ai/src/packages/project-host && pnpm build:bundle`
  3. make sure `https://lite4b.cocalc.ai/software/project-host/latest-linux.json` shows the new version
  4. then use `Deploy hub latest` or the equivalent host upgrade command

## Important deploy caveat

- `cocalc dev sync project-host --host ...` does **not** publish the locally built bundle anywhere.
- It only:
  - builds `packages/project-host/build/bundle-linux.tar.xz`
  - then tells the host to upgrade from the hub's current `/software/project-host/latest-linux.json`
- Therefore, if the hub's `latest` manifest is stale, `dev sync project-host` can report success while the host actually stays on the old version.

## Host rollout caveat

- A host can physically install a new `project-host` artifact while the control plane still reports rollback or non-convergence.
- On `host4`, this was visible as:
  - `installed_version` changed to the new artifact
  - but `desired_version` and top-level observed version still remained on the old artifact during reconcile
- So host upgrade failures must be interpreted carefully:
  - distinguish `artifact installed` from `runtime stack converged`

## Host runtime supervision

- `project-host` on these dev hosts is not managed by a normal systemd unit.
- It is supervised by the project-host watchdog / ctl scripts.
- Useful host-side entrypoints:
  - `/home/ubuntu/cocalc-host/bin/ctl`
  - `/home/ubuntu/cocalc-host/bin/start-project-host`
  - `/home/ubuntu/cocalc-host/bin/fetch-project-host.sh`
  - `/opt/cocalc/project-host/bin/ctl`
- Watchdog log:
  - `/mnt/cocalc/data/logs/project-host-watchdog.log`

## Rustic / backup notes

- For this setup, direct rustic commands from the host shell work and are a valid source of truth when debugging backup/index behavior.
- Be careful about rustic snapshot ids:
  - human `snapshots` output can show ids that are not the same field you should assume from JSON
  - use the JSON `id` when testing exact-id restore or lookup behavior
- Backup indexing is important and should remain the primary fast-browse path.
- The anti-pattern to avoid is treating a remote rustic listing as an immediate deletion oracle for local index state.

## Practical verification commands

- Check what the public hub is advertising:
  - `curl -fsSL https://lite4b.cocalc.ai/software/project-host/latest-linux.json`
- Check the local built identity:
  - `cat /home/user/cocalc-ai/src/packages/project-host/build/bundle/build-identity.json`
- Check a host:
  - `cd /home/user/cocalc-ai/src && eval "$(pnpm -s dev:hub:env)"`
  - `node packages/cli/dist/bin/cocalc.js host get <host-id> --json`
