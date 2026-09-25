# Provider Namespace / Cloud Credential Copy Checkpoint

Scope: independent tests and read-only setup inspection in
`/home/user/cocalc-course-funding-v2`, branch
`feature/course-sponsored-compute-v2`. No worker, metering, settlement or provider
implementation edits. No cloud calls, credentials copied, hub restarts or commits.

## Actual Provider Boundary Coverage

`packages/server/compute/provider-inventory-isolation.test.ts` calls the real
`provider.ts` inventory and orphan mutation functions with SDK/configuration
dependencies mocked. It covers both GCP and Nebius:

- Mixed inventory excludes other deployments, bays, environments, legacy
  unreferenced names and malformed prefixes. Owned home-volume disks remain
  observable alongside VM disks.
- Explicitly referenced legacy database resources remain visible for compatibility
  but cannot be orphan-remediated under another namespace.
- Missing deployment identity discovers no unreferenced resources.
- Changing the bay after discovery makes all four orphan mutations reject before
  credential loading/provider mutation.
- Orphan instance deletion preserves separate data disks; the boot-disk deletion
  path rejects home-volume names.
- SDK failures, including a failed GCP page after a successful page and failures
  after Nebius instance discovery, reject rather than return partial authoritative
  inventory. Inventory calls never invoke mutation adapters.
- A volume-only GCP database still observes its disk inventory.

These tests complement main's resource-name/provider tests and worker-level
deployment-isolation tests. They do not establish IAM, network, DNS, API pagination
adapter behavior, actual provider credentials or live cloud acceptance.

## Local Setup Observed

- `.local/hub-daemon.env` declares bay `funding-v2-dev` and exports deployment ID
  `course-funding-v2-isolated-qa`. `scripts/dev/hub-daemon.sh` sources this file
  and explicitly exports `COCALC_BAY_ID` when launching the hub.
- No explicit `COCALC_COMPUTE_VM_ENVIRONMENT` was found in that env file.
  `server/compute/config.ts` otherwise derives it from site DNS settings. Pin an
  exported `development` value before the coordinated v2 restart, rather than
  inherit an environment from copied settings. No env file was changed here.
- The local hub log names this worktree's
  `src/data/app/postgres/local-postgres.env` and port 19200. This is supporting
  configuration evidence, not proof of the running process's database identity.
- Reading the PID's `/proc/.../cwd` was denied; runtime cwd/environment were not
  independently verified. Main must verify the actual v2 process at the coordinated
  restart. No attempt was made to bypass process permissions.

## Copy / Launch Gates For Main

1. Wait for Kuhn/Nietzsche's core billing/enforcement fixes and checks. Keep the
   original live hub unchanged. Confirm the actual v2 process uses this worktree,
   isolated database, distinct bay/deployment and explicit compute environment.
2. Copy only an approved minimal credential/network configuration allowlist,
   preferably using a dedicated provider project/tenant and least-privilege test
   credentials. Do not bulk-copy site settings or assume `auto` mode is isolated:
   staging auto mode can use legacy provider credentials. Set explicit compute
   mode/canary access and conservative resource limits.
3. Do not copy live compute VM/volume rows, lifecycle requests, resource bindings,
   project-host authority or queued work into the test database. Namespace checks
   protect orphan discovery/remediation, not normal lifecycle operations on
   database-authoritative resource IDs. Inventory intentionally includes explicitly
   referenced legacy IDs; normal VM stop/delete still honors those records.
4. With credentials available and mutations disabled, inspect provider inventory
   read-only and compare names/IDs against the intended namespace and all existing
   resources. Confirm GCP project/network/subnet/flow-log configuration and Nebius
   configured region/parent/subnet mappings. Nebius inventory traverses configured
   regions, not just regions represented by database rows.
5. Only after reviewing the protected-resource set and fixing core checks, authorize
   a bounded canary lifecycle in v2. A mocked SDK pass alone is not cloud-copy or
   production-launch approval.

## Validation

Final focused PGlite Jest run: five suites passed, 42 tests passed (16 new boundary
tests plus 26 existing tests). Suites: `provider-inventory-isolation`,
`resource-names`, `provider`, `orphan-ownership`, `deployment-isolation`.
Prettier passed for the new test and both checkpoint documents. No full package
typecheck or live cloud test was performed for this test/documentation checkpoint.
