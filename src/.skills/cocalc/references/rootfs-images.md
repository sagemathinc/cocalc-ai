# RootFS Recipes And Publishable Images

## Development Flow

Use this sequence for a new tool image:

1. Install and test in a normal CoCalc Basic project.
2. Convert the steps into a deterministic recipe.
3. Add smoke tests that run during recipe verification.
4. Run the recipe locally with `rootfs recipe run --here`.
5. Build in a clean builder project from an admin-authenticated session.
6. Publish only after the clean build and a fresh project acceptance test pass.

The agent's current project-scoped token may handle step 4 but often cannot
create the clean builder project or publish an official image.

## Local Recipe Test

```bash
COCALC_PROJECT_ID="$COCALC_PROJECT_ID" \
  "/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" --json rootfs recipe run \
  --here \
  --config-out /home/user/<tool-project>/rootfs-config.here-test.json \
  --step-timeout 2400 \
  /home/user/<tool-project>/recipes/<tool>.yaml
```

Verify the install step, every recipe verify command, and generated config.

## Clean Build And Publish

Run from an admin-authenticated CoCalc session or UI:

```bash
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" rootfs build \
  /home/user/<tool-project>/recipes/<tool>.yaml \
  --title "RootFS build: <Tool>" \
  --config-out /home/user/<tool-project>/rootfs-config.generated.json
```

Attach:

```bash
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" rootfs build-attach \
  --project <builder-project-id>
```

Publish:

```bash
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" rootfs build-publish \
  --project <builder-project-id> \
  --config-file /home/user/<tool-project>/rootfs-config.generated.json \
  --official \
  --prepull \
  --wait
```

If this fails with permission denied under agent auth, that is expected. Use the
admin UI or an interactive admin-authenticated CLI session.

## Required Artifacts

For each serious image effort, leave behind:

- `README.md` with install and publish instructions
- `AUDIT.md` with source inspected, tests run, blockers, and residual risks
- `recipes/<tool>.yaml`
- install scripts under `scripts/`
- smoke tests under `scripts/`
- at least one `.ipynb` example when the tool is notebook-facing
- `rootfs-config.json`
- optional explicit package lock/spec for reproducibility investigation

## Acceptance Criteria

- Recipe is deterministic enough to rebuild.
- Clean builder project succeeds.
- All verify commands pass.
- Published image starts a new project.
- Default kernel and CLI wrappers work.
- Domain smoke tests pass in the fresh project.
- Notebook examples render without CoCalc-specific UI failures.
