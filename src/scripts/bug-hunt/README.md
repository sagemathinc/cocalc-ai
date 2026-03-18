# Bug Hunt Scripts

This directory contains local workflow helpers for CoCalc bug hunting.

These scripts are for:

- picking likely-live bugs from `wstein.tasks`
- attaching to the right dev/browser environment
- seeding repro fixtures
- capturing artifacts
- running Launchpad / cloud canaries against real project-host flows
- writing bug-hunt ledger entries
- planning and running queued bug-hunt batches
- recovering attribution after long runs

This is not a general user-facing CLI. It exists to support repeated QA and overnight bug-hunt work in this repo.

## Related Files

- Repo skill copy: `src/.skills/cocalc-bug-hunter/SKILL.md`
- Workflow/spec: `src/.agents/bug-hunter.md`
- Exploratory QA scenarios: `src/.agents/bug-hunt/scenario-catalog.md`
- Launchpad/cloud portfolio: `src/.agents/bug-hunt/launchpad-portfolio.md`
- Generated artifacts and ledger: `src/.agents/bug-hunt/`

Note: the active runtime skill still lives in `~/.codex/skills/cocalc-bug-hunter/`; the repo copy is the reviewed source of truth for changes.

## Common Entry Points

- `pnpm -C src bug-hunt:preflight`
- `pnpm -C src bug-hunt:extract -- --fresh`
- `pnpm -C src bug-hunt:attach -- --mode lite --json`
- `pnpm -C src bug-hunt:launchpad-canary -- --provider gcp --list-presets --json`
- `pnpm -C src bug-hunt:launchpad-queue -- --provider gcp --provider lambda --scenario persistence --json`
- `pnpm -C src bug-hunt:run-plan -- --list-plans`
- `pnpm -C src bug-hunt:queue-from-tasks -- --tasks /path/to/wstein.tasks --fresh --dry-run --json`
- `pnpm -C src bug-hunt:status`

Most generated state under `src/.agents/bug-hunt/` is intentionally gitignored.
