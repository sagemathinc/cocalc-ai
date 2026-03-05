## Real Bug Hunt (Lite, Strict)

This profile is built from `/home/wstein/cocalc.com/work/wstein.tasks` (JSONL),
filtered to open (`done != true`, `deleted != true`) entries with `#bug` or
`#blocker`, then narrowed to lite-automatable areas.

### Severity

- `high`: data loss, uncloseable/unrecoverable UI, blanked editor/notebook/terminal, or persistent control-plane failure.
- `medium`: broken workflow with reload/workaround required.
- `low`: lag/cosmetic/inconsistent state that self-recovers.

### Targeted tasks in the strict plan

- `ae963ea3-20fd-4218-8088-743f21d7d5ce` (high) extensionless file open flow (`/home/wstein/bin/backup`) hangs/uncloseable tab.
- `9205fae6-cb04-48b4-bfb7-0147ca3388e5` (medium) files filter intermittently shows no results.
- `9714151e-704d-4060-92a8-096a74101e9a` and `62209823-967c-49dd-9b32-812bcc58abac` (high) terminal blanking/instability.
- `9da0bf11-cd8a-4c6f-a133-27819871a942` (medium) long restore delay/blank period after reload.
- `439cd914-dd02-4a2f-8b67-25e70e0cd54d` (high, proxy) jupyter blank-surface detection.

### Files

- Plan JSON: `src/.agents/real-bug-hunt-lite.plan.json`
- Runner: `src/scripts/dev/run-real-bug-hunt-lite.sh`

### Run

From `src/`:

```bash
./scripts/dev/run-real-bug-hunt-lite.sh 3600
```

Artifacts are written under `/tmp/hunt-real-bugs-v2-<timestamp>/`.
