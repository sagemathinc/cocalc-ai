# L0.5 Rocket Operator CLI And Artifact Model

Status: design proposal for launch-readiness work.

Target: introduce one coherent operator surface for Rocket deployments, release
artifacts, software channels, and backup/restore operations before completing
the L2 restore-drill work.

## Problem

We have many of the necessary operational pieces, but they are spread across
scripts, environment variables, and local operator memory.

Examples:

- `packages/plus/sea/publish-sea.sh` already publishes artifacts to R2, but it
  expects bucket, prefix, latest-manifest key, and public base URL configuration
  in environment variables.
- Hosted Rocket deploy and host-upgrade flows are scriptable, but the operator
  has to know which script to run, which environment to load, and which artifact
  channel is safe.
- Backup status, restore drills, release promotion, and rollback should be
  ordinary repeatable operations, not archaeology through `src/scripts`.

This is manageable for an agent or someone who has the repository loaded in
their head. It is too fragile for a human operator during a launch incident.

## Why This Is L0.5

The public launch readiness plan currently has:

- L0: release channels and promotion.
- L1: rollback and kill switches.
- L2: backup and restore drills.
- L3: monitoring and alerting.
- L4+: launch smoke and operational hardening.

This work belongs between L0 and L2 because L2 depends on it in practice. A
restore drill is not credible if it requires undocumented scripts, manual
environment variables, and personal memory. The same is true for safe deploy and
rollback.

L0.5 should produce the minimum operator model that makes the remaining launch
work repeatable.

## Goals

- Provide one high-level CLI surface for administering Rocket deployments:
  `cocalc rocket ...`.
- Use declarative cluster configuration files instead of ad hoc environment
  variables for human workflows.
- Store artifact credentials in config or referenced secret files with strict
  permissions checks.
- Treat R2/object storage as the artifact distribution layer, not the hub.
- Keep release artifacts immutable and move channels by updating small
  manifests.
- Make every important operation support `--dry-run` and `--json`.
- Make it easy for an operator or Codex to discover status, deploy, roll back,
  check backups, and run smoke tests without reading implementation scripts.

## Non-Goals

- Do not replace every existing deployment script immediately.
- Do not build a full Kubernetes/Helm clone.
- Do not require every development site to adopt the full production config
  model on day one.
- Do not make the hub serve large artifact downloads to project hosts.
- Do not solve multi-bay production rollout completely in the first slice.

## Mental Model

The closest analogy is the Kubernetes operator workflow:

- Object storage or registry is the artifact store.
- `cocalc rocket` is the operator CLI, roughly comparable to a narrow
  `kubectl`/Helm workflow.
- `rocket.yaml` is the declarative cluster configuration.
- Channel manifests are the small mutable pointers from public names to
  immutable releases.

This is not Kubernetes, but the operator experience should have the same core
properties: visible state, repeatable commands, explicit targets, dry runs, and
rollback.

## Configuration Model

Human operators should not have to export a dozen R2 variables into their shell.
Instead, the CLI should load a config file.

Possible locations:

- Explicit: `cocalc rocket --config ./ops/prod.rocket.yaml ...`
- User default: `~/.config/cocalc/rocket/config.yaml`
- Environment override for CI: `COCALC_ROCKET_CONFIG=/path/to/config.yaml`

Example:

```yaml
clusters:
  prod:
    hub_url: https://cocalc.ai
    auth_profile: prod-admin
    artifact_store:
      kind: r2
      bucket: cocalc-ai-artifacts
      public_base_url: https://artifacts.cocalc.ai
      endpoint: https://<cloudflare-account-id>.r2.cloudflarestorage.com
      credentials_file: ~/.config/cocalc/rocket/prod-r2.env
    manifests:
      base_key: software/rocket/channels
    ssh:
      bastion: ubuntu@prod-bay

  staging:
    hub_url: https://staging.cocalc.ai
    auth_profile: staging-admin
    artifact_store:
      kind: r2
      bucket: cocalc-ai-artifacts
      public_base_url: https://artifacts.cocalc.ai
      endpoint: https://<cloudflare-account-id>.r2.cloudflarestorage.com
      credentials_file: ~/.config/cocalc/rocket/staging-r2.env
    manifests:
      base_key: software/rocket-staging/channels
```

Example credentials file:

```dotenv
CLOUDFLARE_ACCOUNT_ID=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
CLOUDFLARE_API_TOKEN=...
```

The config file should contain non-secret configuration when possible. Secret
material should live in referenced files. For small self-contained installs, a
single secret-bearing config file can be allowed, but only with strict
permissions.

## Permission Checks

The CLI must fail closed when it sees insecure secret storage.

Required checks:

- Config files containing inline secrets must be mode `0600`.
- Referenced secret files must be mode `0600`.
- Parent directories containing secret files must not be group- or
  world-writable.
- Symlinks should be resolved before checking permissions.
- Error messages should include exact remediation commands, for example:
  `chmod 600 ~/.config/cocalc/rocket/prod-r2.env`.

The CLI must never print secret values in normal output, logs, errors, or JSON.
All config display commands should redact credential fields.

Environment variables should remain supported as a CI escape hatch and for
backward compatibility, but they should no longer be the primary human workflow.

## Artifact Store Model

The hub should coordinate deploys and host upgrades, but large artifacts should
be fetched directly from R2 or another object store.

Reasons:

- Upgrading many project hosts should not make the hub an artifact bottleneck.
- Hub egress for repeated bundle downloads is avoidable spend.
- The same immutable artifacts should be reusable across staging, production,
  Star, Plus, and local install testing.
- Object storage plus Cloudflare caching gives better global distribution.

The CLI should support an artifact-store abstraction with R2 first:

- `kind: r2`
- bucket
- public base URL
- S3-compatible endpoint
- credentials file
- optional prefix

Future stores can be added later if needed, but R2 is the launch target.

## Artifact Layout

Artifacts should be immutable and content-verifiable. Channels should be small
mutable manifests.

Suggested Rocket layout:

```text
software/rocket/releases/<release-id>/hub-bundle.tar.xz
software/rocket/releases/<release-id>/hub-bundle.tar.xz.sha256
software/rocket/releases/<release-id>/project-host-linux-amd64.tar.xz
software/rocket/releases/<release-id>/project-host-linux-amd64.tar.xz.sha256
software/rocket/releases/<release-id>/project-bundle.tar.xz
software/rocket/releases/<release-id>/project-bundle.tar.xz.sha256
software/rocket/releases/<release-id>/tools-linux-amd64.tar.xz
software/rocket/releases/<release-id>/tools-linux-amd64.tar.xz.sha256
software/rocket/releases/<release-id>/manifest.json
software/rocket/channels/candidate.json
software/rocket/channels/stable.json
```

Suggested Plus layout:

```text
software/cocalc-plus/releases/<version>/cocalc-plus-<version>-<os>-<arch>
software/cocalc-plus/releases/<version>/manifest.json
software/cocalc-plus/channels/stable-<os>-<arch>.json
software/cocalc-plus/channels/candidate-<os>-<arch>.json
```

Suggested Star layout:

```text
software/cocalc-star/releases/<release-id>/install-cocalc-star-local.sh
software/cocalc-star/releases/<release-id>/install-cocalc-star-local-lima.sh
software/cocalc-star/releases/<release-id>/manifest.json
software/cocalc-star/channels/candidate.json
software/cocalc-star/channels/stable.json
```

Every manifest should include:

- product
- release id
- channel, if it is a channel manifest
- commit sha
- build timestamp
- promoted timestamp, if applicable
- artifact URLs
- sha256 values
- size
- platform
- optional revoked or known-bad flag

## CLI Surface

Initial namespace:

```text
cocalc rocket config check --cluster prod
cocalc rocket config show --cluster prod

cocalc rocket artifacts publish --product plus --file <path> --channel candidate
cocalc rocket artifacts list --product rocket
cocalc rocket artifacts verify --release <release-id>

cocalc rocket channels show --product rocket --cluster prod
cocalc rocket channels promote --product rocket --from candidate --to stable
cocalc rocket channels rollback --product rocket --channel stable

cocalc rocket status --cluster prod
cocalc rocket deploy --cluster prod --channel candidate --dry-run
cocalc rocket rollback --cluster prod --to previous --dry-run
cocalc rocket hosts upgrade --cluster prod --target project-host --channel stable

cocalc rocket backups status --cluster prod
cocalc rocket restore postgres --cluster staging --backup <backup-id> --dry-run
cocalc rocket smoke --cluster prod
```

All commands should support:

- `--config`
- `--cluster`
- `--json`
- `--dry-run` for mutating operations
- clear nonzero exit codes

Destructive or sensitive commands should require fresh admin authorization where
they touch the hub or live cluster state.

## First Implementation Slice

The first slice should be deliberately small.

1. Add a Rocket config loader in the CLI package.
2. Add strict permission checks for config and credential files.
3. Add `cocalc rocket config check`.
4. Add `cocalc rocket config show` with secret redaction.
5. Add R2 credential resolution from the config model.
6. Update the Plus SEA publish path so a human can publish using:

```sh
cocalc rocket artifacts publish \
  --product plus \
  --cluster prod \
  --file packages/plus/build/sea/cocalc-plus-...
```

or, as a compatibility bridge:

```sh
COCALC_ROCKET_CONFIG=~/.config/cocalc/rocket/config.yaml \
  packages/plus/sea/publish-sea.sh
```

This slice should not require changing every deployment script. It should prove
the config and artifact-store model on a path that already works: Plus SEA
publishing to R2.

## Later Implementation Slices

### Slice 2: Channel Commands

- Add publish-to-candidate and promote-to-stable flows.
- Add rollback by repointing a channel manifest.
- Support Star, Plus, and Rocket manifests with a shared schema.

### Slice 3: Rocket Status And Deploy Wrappers

- Wrap existing deploy and host-upgrade scripts behind `cocalc rocket`.
- Show the selected cluster, active channel, deployed versions, host versions,
  and artifact source.
- Make deploy and rollback plans visible before mutation.

### Slice 4: Backup And Restore Commands

- Add backup status views for Postgres, R2 project backups, rootfs artifacts,
  and release artifacts.
- Add restore drill commands that can target a staging cluster.
- Make the L2 restore runbook executable without digging through scripts.

### Slice 5: Multi-Site Promotion

- Support promoting the same immutable release from staging to production.
- Support distinct channel manifests per site.
- Add policy checks before stable promotion, such as smoke-test pass status.

## Relationship To Existing Scripts

Existing scripts should not be deleted early. The first goal is to put a stable
operator facade in front of them.

Near-term strategy:

- Keep scripts as implementation details.
- Move shared logic into package code where practical.
- Have scripts call the same config loader when they need artifact credentials.
- Prefer the CLI for documentation and runbooks.

Long-term strategy:

- Scripts become thin wrappers or disappear.
- Operator runbooks use `cocalc rocket ...` exclusively.

## Security Requirements

- Do not print secrets.
- Redact secrets in JSON output.
- Fail closed on insecure secret file permissions.
- Require explicit cluster selection for mutating commands unless there is a
  single configured cluster.
- Require fresh auth for live destructive operations:
  - deploy,
  - rollback,
  - restore,
  - stable-channel promotion,
  - host upgrades.
- Audit live operations through the hub where possible.
- Use immutable artifacts plus sha256 verification before install or upgrade.

## Acceptance Criteria For L0.5

- An operator can publish a Plus artifact to R2 without manually exporting R2
  environment variables.
- `cocalc rocket config check` catches insecure config and secret-file
  permissions.
- `cocalc rocket channels show` can display candidate and stable manifests.
- `cocalc rocket status` can show the configured cluster target and artifact
  source.
- A runbook can describe deploy, rollback, and backup-status discovery using
  `cocalc rocket ...` commands instead of script paths.
- The L2 restore-drill plan can depend on this CLI without requiring personal
  memory of environment variables.

## Open Questions

- Should production cluster config live in a private ops repository, or in a
  user-local config file only?
- Should Star product commands live under `cocalc rocket ...` or have a separate
  `cocalc star ...` namespace for local-installer workflows?
- Should channel promotion write only to R2, or also create/update GitHub
  releases?
- Should all products share one bucket with prefixes, or should production
  Rocket artifacts be isolated in a separate bucket?
- How should first-cluster bootstrap work before a hub exists to authorize
  operations?
- Do we want sops/age support immediately, or is strict local file permissions
  enough for the first launch?

## Recommendation

Start with the config loader, permission checker, and Plus SEA publish path.
That gives immediate operator value, removes the R2 environment-variable pain,
and establishes the same artifact-store model needed for Rocket deploys,
rollbacks, Star channels, and L2 restore drills.

