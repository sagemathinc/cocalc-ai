# Deploy And Rollback Reproducibility Smoke

Status: live smoke passed for non-destructive deploy/rollback readiness on
`lite4b`, 2026-05-11.

Purpose:

- make release build, deploy inspection, rollback target selection, and
  post-deploy verification repeatable
- avoid operator-only knowledge for project-host runtime deployment work
- keep rollback commands safe to rehearse before an incident

## Scope

This smoke covers the local 3-bay hub plus one live dedicated project host:

- hub cluster: `bay-0`, `bay-1`, `bay-2`
- host: `host1`
- host id: `c2c1bb5b-d5fb-4a06-8904-4549f4089ac2`
- current project-host runtime:
  `20260510T153947Z-0fdb62eff609`

It intentionally does not perform a live rollback, because rollback changes
desired state and restarts managed host components. The CLI now supports a
non-mutating `--dry-run` so operators can prove the selected rollback target
before changing anything.

## Operator Workflow

Always refresh hub environment before live control-plane commands:

```sh
cd /home/user/cocalc-ai/src
eval "$(pnpm -s dev:hub:env)"
```

Build and restart the local 3-bay hub:

```sh
pnpm dev:hub:build
pnpm dev:hub:restart
pnpm dev:hub:status
```

Verify control-plane reachability:

```sh
node packages/cli/dist/bin/cocalc.js host list --json
node packages/cli/dist/bin/cocalc.js host deploy status host1
node packages/cli/dist/bin/cocalc.js host deploy history host1 --limit 20
```

Verify rollback candidates without changing desired state:

```sh
node packages/cli/dist/bin/cocalc.js host deploy rollback host1 \
  --component project-host \
  --dry-run \
  --json

node packages/cli/dist/bin/cocalc.js host deploy rollback host1 \
  --component project-host \
  --last-known-good \
  --dry-run \
  --json
```

Verify runtime reconcile path without forcing a restart when already aligned:

```sh
node packages/cli/dist/bin/cocalc.js host deploy reconcile host1 \
  --component acp-worker \
  --reason deploy_rollback_repro_smoke \
  --wait \
  --json
```

Use an actual rollback only during a canary or incident:

```sh
node packages/cli/dist/bin/cocalc.js host deploy rollback host1 \
  --component project-host \
  --reason <reason> \
  --wait
```

or, to use the host-agent recorded recovery target:

```sh
node packages/cli/dist/bin/cocalc.js host deploy rollback host1 \
  --component project-host \
  --last-known-good \
  --reason <reason> \
  --wait
```

After a rollback or rollout, verify:

```sh
node packages/cli/dist/bin/cocalc.js host deploy status host1
node packages/cli/dist/bin/cocalc.js host deploy history host1 --limit 5
psql -Atqc "select kind || '|' || status || '|' || count(*) from long_running_operations where created_at > now() - interval '24 hours' group by kind, status order by kind, status;"
```

## Smoke Results

Preflight:

- `pnpm -C src bug-hunt:preflight -- --json`: passed
- `pnpm -C src/packages/cli tsc --build`: passed
- `pnpm -C src/packages/cli build`: passed

Hub status:

- 3 bays running
- seed bay: `bay-0`
- hub URL: `http://localhost:9100`

Host status:

- `host1` is running on `bay-0`
- current project-host version is
  `20260510T153947Z-0fdb62eff609`
- current `acp-worker` is running and aligned to
  `20260510T153947Z-0fdb62eff609`

Rollback dry-run:

- previous-version dry-run selected
  `20260510T044911Z-65ccdc8ef43a`
- last-known-good dry-run selected
  `20260506T053603Z-573183037d26`
- no rollback LRO was queued by either dry-run

Reconcile smoke:

- command:
  `host deploy reconcile host1 --component acp-worker --reason deploy_rollback_repro_smoke --wait --json`
- LRO: `79bc1786-d1c6-44fb-8431-040c371f87fa`
- result: `succeeded`
- decision: `already_aligned`
- reconciled components: none

## Remaining Release Work

The deploy/rollback path is now reproducible enough for ordinary operator
inspection and non-destructive rollback rehearsal.

Remaining work before calling this fully done:

- perform one intentional canary rollback and forward rollback on a disposable
  or low-risk host
- document exact expected user-facing verification after a real component
  restart, e.g. project open, terminal open, file save, and ACP worker action
- decide whether `host deploy rollback --dry-run` should also be exposed in the
  admin UI before first public release
