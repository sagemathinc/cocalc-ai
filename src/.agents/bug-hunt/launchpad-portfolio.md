# Launchpad Bug-Hunt Portfolio

This is the repo-side working note for autonomous bug hunting against CoCalc Launchpad and remote project hosts.

## Why This Exists

Launchpad reliability is currently a high-value bug-hunt target:

- host boot / stop / delete across `gcp`, `lambda`, `nebius`, `hyperstack`
- project placement and startup on fresh or existing hosts
- snapshots, backups, moves, and path copy between projects
- SSH / proxy / app reachability on real remote hosts

This surface is much more automation-friendly than UI bug hunting, but it also costs real money and can leak resources if the workflow is careless.

## Operating Rules

- Keep live concurrency at `1` host-flow at a time.
- Use only checked-in cheap smoke presets unless there is a deliberate override.
- Default to `--failure-policy stop` until cleanup-on-failure is stronger.
- Default to `--cleanup-on-success`.
- Treat a cleanup failure as a human-review event, not something to ignore.
- Record every live run under `src/.agents/bug-hunt/launchpad-runs/`.

## Initial Time Budgets

These are the starting host-ready budgets for the canary runner:

- `gcp`: `180s`
- `lambda`: `420s`
- `nebius`: `300s`
- `hyperstack`: `900s`

Additional default budgets:

- host stopped: `180s`
- project ready: `300s`
- backup visible: `900s`

These should be treated as explicit product expectations that can later be tightened or split into cached vs uncached cases.

## First Nightly Target

The first useful overnight target is not an open-ended cloud sweep. It is a controlled canary matrix:

- providers: one or more of `gcp`, `lambda`, `nebius`, `hyperstack`
- scenario: start with `persistence`
- execution mode: `cli`
- failure policy: `stop`
- cleanup on success: enabled

Useful commands:

```sh
pnpm -C src bug-hunt:launchpad-canary -- --provider gcp --list-presets --json
```

```sh
pnpm -C src bug-hunt:launchpad-canary -- \
  --provider gcp \
  --provider nebius \
  --scenario persistence \
  --dry-run \
  --json
```

```sh
pnpm -C src bug-hunt:launchpad-canary -- \
  --provider gcp \
  --provider nebius \
  --scenario persistence \
  --failure-policy stop \
  --json
```

Queueing several jobs and avoiding repeated successful runs:

```sh
pnpm -C src bug-hunt:launchpad-queue -- \
  --provider gcp \
  --provider lambda \
  --scenario persistence \
  --failure-policy continue \
  --json
```

If you rerun the same `--queue-dir`, previously successful jobs are skipped and only unfinished or failed jobs are attempted again.

## Next Expansion

Once the basic canary is trustworthy, expand one scenario family at a time:

1. `persistence`
2. `apps`
3. `move`
4. `drain`
5. backup / copy-path / snapshot-specific workflows if they need dedicated wrappers

The goal is to make real Launchpad state-machine failures easy to reproduce, log, and fix without turning overnight testing into an uncontrolled cloud spend.
