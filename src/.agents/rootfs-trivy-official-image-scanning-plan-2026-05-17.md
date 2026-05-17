# Trivy Scanning for Official RootFS Images

Status: proposed implementation plan, 2026-05-17.

This plan scopes `SEC-SCAN-001` to one product goal:

- Make official/shared RootFS images more trustworthy before users select them.

It intentionally does not implement general user-project scanning, arbitrary
filesystem scanning, SAST, malware scanning, or self-service scans for
non-admins. Those can become separate workstreams later.

## User-Facing Goal

When a user sees or selects a RootFS image, CoCalc should show whether the
specific immutable release has been vulnerability-scanned.

The scan status should appear in:

- the RootFS image list,
- the selected-image details pane,
- and project settings where a user reviews or changes the project RootFS.

The details should include:

- last scan time,
- scanner name and version,
- vulnerability database timestamp or digest,
- result status,
- severity counts,
- a concise list of the highest-severity findings,
- a link or drill-down to the full admin-visible report,
- and admin notes for false positives, accepted risk, or remediation guidance.

If an official/shared image has unresolved critical vulnerabilities, ordinary
users should not be able to newly select it. Existing projects should not be
forcibly changed just because a scan result changes; instead project settings
should warn clearly and encourage switching to a safer image.

## Why This Is RootFS-Only First

Official RootFS images are a high-leverage trust boundary. One vulnerable image
can be selected by many projects, and the vulnerability may exist before any
user has created project files. Scanning official images gives admins a concrete
release-quality control without exposing arbitrary user files to scanner
parsers or creating broad privacy/retention questions.

The current code already has the right placeholders:

- `rootfs_releases.scan_status`
- `rootfs_releases.scan_tool`
- `rootfs_releases.scanned_at`
- `rootfs_releases.scan_summary`
- `RootfsImageEntry.scan`
- existing project-settings scan rendering via `renderRootfsScan`

The first implementation should fill, display, and enforce those fields.

## Scanner Recommendation

Use Trivy as the first scanner for this feature.

Reasons:

- Trivy has a `rootfs` target mode for scanning a mounted or unpacked RootFS
  directory.
- Trivy supports machine-readable JSON/SARIF-style output and SBOM formats.
- Trivy can generate SPDX/CycloneDX SBOM output from `rootfs`, `fs`, and image
  targets.
- Trivy has documented air-gapped/offline database workflows, which matters for
  Launchpad/Rocket deployments that should not depend on ad hoc external
  network access from project hosts.

Credible alternatives:

- Grype/Syft is the main fallback or second-opinion path.
- OSV-Scanner is useful for source/lockfile/SBOM dependency checking, but it is
  less directly aligned with OS-package-heavy RootFS image trust.
- Semgrep, Gitleaks, ClamAV, and broader project scanners are intentionally
  out of initial scope.

References:

- Trivy rootfs CLI: <https://trivy.dev/v0.32/docs/references/cli/rootfs/>
- Trivy SBOM support: <https://trivy.dev/docs/v0.59/guide/supply-chain/sbom/>
- Trivy air-gapped/offline operation: <https://trivy.dev/docs/latest/guide/advanced/air-gap/>
- Grype scan targets: <https://oss.anchore.com/docs/guides/vulnerability/scan-targets/>
- OSV-Scanner source scanning: <https://google.github.io/osv-scanner/usage/scan-source>

## Authority And Placement

RootFS catalog/release state is bay-owned relational state. The scan execution
should happen on a project host because that is where managed RootFS images are
cached/unpacked and where the relevant filesystem primitives already live.

Design rules:

- The admin request enters through the caller's bay.
- The authoritative bay for the RootFS release resolves the `release_id`,
  verifies admin permission, and creates/updates scan state.
- The owning bay chooses an eligible project host in its bay to execute the
  scan.
- The project host runs Trivy against a read-only RootFS path and returns a
  bounded parsed result plus report artifact reference.
- The authoritative bay writes final `rootfs_releases` scan fields and any
  scan-run history.
- Other bays see results through existing catalog/projection flows, not by
  directly querying a random local bay.

Launchpad is the one-bay special case of the same flow.

## Data Model

Keep latest state on `rootfs_releases`:

- `scan_status`: `unknown`, `pending`, `clean`, `findings`, `error`
- `scan_tool`: e.g. `trivy`
- `scanned_at`
- `scan_summary`

Recommended `scan_summary` shape:

```ts
type RootfsTrivyScanSummary = {
  status: "unknown" | "pending" | "clean" | "findings" | "error";
  policy_status?: "allowed" | "blocked" | "admin_exception";
  tool: "trivy";
  tool_version: string;
  command_mode: "rootfs";
  db?: {
    version?: string;
    updated_at?: string;
    source?: string;
  };
  target: {
    release_id: string;
    content_key: string;
    runtime_image: string;
    arch?: string;
    size_bytes?: number;
  };
  started_at: string;
  scanned_at?: string;
  duration_ms?: number;
  severity_counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
  };
  highest_findings: Array<{
    id: string;
    severity: string;
    package_name?: string;
    installed_version?: string;
    fixed_version?: string;
    title?: string;
    primary_url?: string;
  }>;
  report?: {
    artifact_id?: string;
    format: "trivy-json";
    sha256?: string;
    bytes?: number;
  };
  admin_notes?: Array<{
    account_id: string;
    created_at: string;
    kind: "false_positive" | "accepted_risk" | "remediation" | "admin_bypass";
    note: string;
    finding_ids?: string[];
    expires_at?: string;
  }>;
  error?: {
    message: string;
    code?: string;
  };
};
```

Add a normalized scan-run table. This is SOC-2 evidence, so latest-state fields
alone are not sufficient.

- `rootfs_release_scan_runs`
- primary key `scan_run_id`
- `release_id`
- `requested_by`
- `requested_at`
- `started_at`
- `completed_at`
- `host_id`
- `tool`
- `tool_version`
- `db_version`
- `status`
- `severity_counts`
- `summary`
- `report_artifact`
- `error`

Latest fields are enough for the product UI, but historical runs are necessary
for audits, scanner upgrades, and evidence that stale findings were rechecked.

## Admin Settings

Add site settings for policy and operations:

- `rootfs_scan_enabled`: default `no` until Trivy is installed/configured.
- `rootfs_scan_tool`: default `trivy`.
- `rootfs_scan_container_image`: pinned internal Trivy scanner image reference,
  ideally by digest.
- `rootfs_scan_container_image_digest`: expected image digest for startup
  verification.
- `rootfs_scan_max_concurrent_per_bay`: default `1`.
- `rootfs_scan_max_concurrent_per_host`: default `1`.
- `rootfs_scan_timeout_minutes`: default `30`.
- `rootfs_scan_max_target_gb`: default based on current official image sizes.
- `rootfs_scan_block_severity`: default `critical`.
- `rootfs_scan_stale_after_days`: default `30`.
- `rootfs_scan_unscanned_official_policy`: `warn` first, later `block` if
  admins want strict release gates.
- `rootfs_scan_admin_bypass_requires_note`: default `yes`.
- `rootfs_scan_full_report_retention_days`: default `730`.
- `rootfs_scan_rescan_period_days`: default `7`, adjustable after measuring
  real resource usage.

Operational settings should be readable by the owning bay and project-host scan
worker. They should not rely on unversioned host-local environment variables
except for deployment-local defaults such as scanner image cache and Trivy DB
cache directory.

Policy decisions for first implementation:

- Unscanned official images are `warn`, not `block`, until baseline scans exist.
- Full JSON reports are retained for two years.
- Admin scan bypass requires fresh-auth and a required note.
- Official images are scheduled for weekly re-scan, but the period remains
  admin-configurable because real scan cost is not known yet.

## Project Host Execution

Add a host-control RPC, for example:

- `scan-rootfs-release`

Input:

```ts
type ScanRootfsReleaseRequest = {
  release_id: string;
  content_key: string;
  runtime_image: string;
  artifact_backend?: string;
  artifact_path?: string;
  timeout_ms: number;
  max_target_bytes: number;
  scanner: "trivy";
  scanner_args_policy_version: string;
};
```

Output:

```ts
type ScanRootfsReleaseResult = {
  status: "clean" | "findings" | "error";
  tool: "trivy";
  tool_version: string;
  db_updated_at?: string;
  severity_counts: Record<string, number>;
  highest_findings: RootfsTrivyScanSummary["highest_findings"];
  report_artifact?: RootfsTrivyScanSummary["report"];
  duration_ms: number;
  error?: string;
};
```

The host should:

1. Resolve or materialize the immutable RootFS release into a host-local cache.
2. Verify the resolved path corresponds to the requested `content_key` /
   managed image metadata.
3. Refuse targets over `max_target_bytes`.
4. Run the pinned Trivy scanner container with a pinned argument policy.
5. Capture JSON output to a temporary file.
6. Parse and summarize findings.
7. Store full report as a bounded internal artifact if report retention is
   enabled.
8. Return only compact, sanitized metadata to the bay.

The scan must run:

- as a non-root scanner user where possible,
- read-only against the RootFS target,
- with no write access to the target,
- with no access to project home directories,
- with CPU/memory/time/process limits,
- with a host-local or bay-mirrored Trivy DB cache,
- and without downloading databases during the scan itself.

## Exact Runtime Model

Run Trivy inside a locked-down Podman container on the project host. Do not run
the Trivy binary directly on the host for production scans.

The host should maintain:

- a pinned scanner image, e.g.
  `registry.cocalc.internal/security/trivy-rootfs@sha256:...`;
- a host-local Trivy database cache, updated by a controlled ops job;
- a per-scan temporary output directory;
- and a read-only materialized RootFS target path.

The scanner container should see only:

- `/scan/rootfs`: read-only mount of the target immutable RootFS tree;
- `/scan/out`: writable empty output directory for JSON/SBOM/report files;
- `/trivy-cache`: read-only Trivy DB/cache directory during scan execution;
- `/tmp`: small tmpfs.

It should not see:

- project home directories,
- project secrets,
- host `/var/run/podman.sock`,
- host network,
- bay credentials,
- rustic repository secrets,
- or arbitrary host filesystem paths.

The scan job should have two container modes:

1. DB update mode, run by ops/admin schedule, with network enabled only if the
   deployment uses direct upstream DB refresh.
2. Scan mode, run for each RootFS release, with `--network=none`,
   `--skip-db-update`, and a read-only DB cache mount.

Preferred scan-mode command shape:

```sh
podman run --rm \
  --name "cocalc-rootfs-scan-${SCAN_RUN_ID}" \
  --network=none \
  --read-only \
  --cap-drop=all \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --memory="${MEMORY_LIMIT}" \
  --cpus="${CPU_LIMIT}" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
  --mount "type=bind,src=${ROOTFS_PATH},dst=/scan/rootfs,ro=true" \
  --mount "type=bind,src=${OUTPUT_DIR},dst=/scan/out" \
  --mount "type=bind,src=${TRIVY_CACHE_DIR},dst=/trivy-cache,ro=true" \
  "${TRIVY_SCANNER_IMAGE}" \
  trivy rootfs \
    --format json \
    --output /scan/out/report.json \
    --scanners vuln \
    --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
    --ignore-unfixed=false \
    --offline-scan \
    --skip-db-update \
    --cache-dir /trivy-cache \
    /scan/rootfs
```

Container user model:

- Prefer rootless Podman if project-host deployment supports it.
- Inside the scanner container, running as root is acceptable if it is root in a
  user namespace, all capabilities are dropped, no new privileges are allowed,
  the target mount is read-only, and network is disabled. This avoids false
  negatives from unreadable package metadata in RootFS trees.
- If non-root scanning has equivalent coverage in practice, switch to a
  non-root scanner user after smoke testing.

Report handling:

- Trivy writes full JSON to `/scan/out/report.json`.
- The host reads, bounds, hashes, and parses the report after the container
  exits.
- The host stores or uploads the full report only through the bay-approved
  artifact path.
- The host returns only compact summary metadata over host-control RPC.

Failure handling:

- Non-zero Trivy exit from findings must be distinguishable from scanner
  execution failure. Prefer not using `--exit-code 1`; let policy decide from
  parsed JSON.
- Container timeout, OOM, missing DB, missing scanner image, target too large,
  and malformed JSON become `scan_status='error'` with a compact error code.
- The temporary output directory is deleted after successful artifact upload or
  after bounded failure retention for debugging.

## Trivy Invocation Policy

The exact command should be centralized and versioned, not assembled ad hoc in
UI or CLI code.

Expected command inside the scanner container:

```sh
trivy rootfs \
  --format json \
  --output "$REPORT_JSON" \
  --scanners vuln \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
  --ignore-unfixed=false \
  --offline-scan \
  --skip-db-update \
  --cache-dir "$TRIVY_CACHE_DIR" \
  "$ROOTFS_PATH"
```

Notes:

- Start with `--scanners vuln`. Secret/config/license scanning is separate
  scope and should not be enabled until the privacy/noise model is explicit.
- Use `--skip-db-update` during scan jobs; update the Trivy DB through a
  controlled admin/ops job instead.
- Use `--offline-scan` to avoid implicit dependency lookups from project hosts.
- Capture `trivy --version` and DB metadata in the scan summary.
- Revisit `--ignore-unfixed` after seeing real official-image noise. For
  policy blocking, unresolved critical findings with no available fixed version
  may need an admin exception path rather than automatic blocking forever.

## Report Storage

Do not store raw reports in browser-visible catalog JSON.

Store:

- compact summary in `rootfs_releases.scan_summary`,
- full Trivy JSON report in internal object storage or a DB-backed artifact
  table, retained for 730 days by default,
- artifact checksum and byte size in the summary,
- and admin notes/exceptions in a normalized notes table or scan-run-linked
  event table, projected into latest summary for UI display.

Full report access should be admin-only. User-facing UI should show concise
severity counts, top findings, and remediation guidance.

## UI Policy

RootFS list:

- Show a compact status chip:
  - `Scanned clean`
  - `Critical findings`
  - `High findings`
  - `Scan stale`
  - `Unscanned`
  - `Scan failed`
- Include last scanned time in tooltip/details.
- For admin users, show a scan action and link to full report/details.

Selected-image detail:

- Show scanner, version, database timestamp, last scan, severity counts, and
  top findings.
- Show admin notes and exception expiration if present.
- For blocked images, show why and what replacement image supersedes it if
  known.

Project settings:

- If the current image has critical findings, warn but do not forcibly switch.
- If selecting a new image with unresolved critical findings, block ordinary
  users and explain that the image must be replaced or re-scanned.
- If the viewer is admin and bypass is enabled, require a note and record it.

Admin RootFS catalog:

- Add `Scan now`, `View report`, `Add exception note`, and `Mark remediation`
  actions.
- Show stale scan and failed scan filters.
- Show official images without a successful scan as an admin attention item.

## Enforcement

Selection enforcement belongs in the same server paths that currently validate
RootFS image selection and trusted catalog/OCI policy.

Rules:

- Apply blocking only to new selection of official/shared catalog entries.
- Do not block a project from starting solely because its current image later
  becomes vulnerable. Warn in settings and admin reports instead.
- Do not block private owner images in the first implementation unless the admin
  explicitly enables that policy later.
- An image is blocked for ordinary users when:
  - scan status is `findings`,
  - critical count is above the configured threshold,
  - no active admin exception covers the finding/policy,
  - and the image is official or broadly shared.
- Admin bypass must record a note; do not silently bypass.

## Multibay Flow

Admin scan request:

1. Browser/CLI calls home bay admin API.
2. Home bay routes to the bay authoritative for the RootFS catalog/release if
   needed.
3. Authoritative bay validates admin freshness if the operation is considered
   dangerous enough for fresh-auth.
4. Bay sets latest release status to `pending` and inserts a scan-run row.
5. Bay chooses a project host in its bay that can materialize the release.
6. Bay calls host-control `scan-rootfs-release`.
7. Host returns compact result.
8. Bay writes final scan state and appends a RootFS image event.
9. Catalog/projection refresh exposes updated scan state to users.

User selection request:

1. Browser calls normal project RootFS selection API.
2. Project owning bay resolves selected catalog entry/release.
3. Bay evaluates scan policy from authoritative RootFS release state.
4. Ordinary user is blocked if policy fails.
5. Admin bypass requires explicit note and records an event.

## Events And Audit

Add RootFS image event types:

- `scan_requested`
- `scan_started`
- `scan_completed`
- `scan_failed`
- `scan_policy_blocked`
- `scan_exception_added`
- `scan_exception_expired`
- `scan_admin_bypass`

Central audit/log events should include:

- admin account id,
- release id,
- image id/runtime image,
- host id,
- scan status,
- severity counts,
- scanner version,
- DB timestamp,
- policy decision,
- and exception note metadata without raw vulnerability report blobs.

## Alerts And Reports

Admin reports should answer:

- Which official images are unscanned?
- Which official images have stale scans?
- Which official images have critical/high findings?
- Which images are blocked from new selection?
- Which images have active admin exceptions?
- Which scans failed repeatedly?
- Which projects currently use an image with critical findings?

CLI candidates:

- `cocalc admin rootfs scans list`
- `cocalc admin rootfs scans run --image-id ...`
- `cocalc admin rootfs scans report --image-id ...`
- `cocalc admin rootfs scans exceptions add --image-id ...`

Prometheus/reporting candidates:

- `cocalc_rootfs_scan_status{bay_id,image_id,release_id,status}`
- `cocalc_rootfs_scan_findings{severity,...}`
- `cocalc_rootfs_scan_age_seconds{...}`
- `cocalc_rootfs_scan_failures_total{...}`
- `cocalc_rootfs_scan_policy_block_total{...}`

## Implementation Phases

### Phase 1: scanner decision and host proof-of-life

- Add pinned Trivy scanner container image discovery/verification on project
  hosts.
- Add a host-local command/helper that runs the locked-down Podman scanner
  container against a known cached managed RootFS path and produces parsed
  summary.
- Capture tool version and DB metadata.
- Verify offline/cache-only mode works.
- Verify `--network=none`, read-only target mount, output-only writable mount,
  and no target modification.

### Phase 2: data model and admin scan API

- Add `rootfs_release_scan_runs` if historical evidence is required now.
- Add server helper to set `pending`, complete scan, and record failure.
- Add host-control RPC for `scan-rootfs-release`.
- Add admin API/CLI command to run a scan for one release/image.

### Phase 3: UI display

- Replace the minimal project-settings scan tag with a richer reusable
  `RootfsScanStatus` component.
- Use it in the RootFS image list, selected details, and project settings.
- Add admin drill-down for report and notes.

### Phase 4: selection policy

- Add server-side selection blocking for official/shared images with unresolved
  critical findings.
- Add admin bypass with required note.
- Add user-facing blocked-selection error copy.

### Phase 5: reporting and launch checks

- Add admin stale/unscanned/finding reports.
- Add central events and optional Prometheus output.
- Add regression tests and a launch smoke checklist.

## Tests

Unit tests:

- parse representative Trivy JSON into severity counts/top findings,
- handle no findings,
- handle unknown severity,
- handle scanner error output,
- apply stale/unscanned/critical/admin-exception policy,
- reject ordinary-user selection of blocked official images,
- allow existing project current image to remain with warning-only semantics,
- require admin note for bypass.

Integration tests:

- admin scan updates `rootfs_releases` from `pending` to final state,
- catalog entry exposes scan summary,
- project settings receives scan summary,
- cross-bay request routes to authoritative bay and host,
- scan failure records error state and event.

Host smoke test:

- install/pin the Trivy scanner container image,
- preload/update DB through controlled path,
- scan a tiny synthetic RootFS with a known package database if practical,
- verify no network access during scan job,
- verify target path remains read-only/unmodified.

## Open Questions

1. Exact exception storage: separate normalized table versus event table plus
   latest projection. Recommendation: use a normalized table if exceptions can
   expire or attach to specific finding IDs; otherwise RootFS image events plus
   latest summary projection is enough.
2. Full report size budget. Need empirical data from scanning current official
   images before choosing DB versus object storage. Default assumption: object
   storage or artifact table with 730-day retention.
3. Re-scan cadence after production measurement. Default weekly, but tune based
   on official image count, RootFS size, host idle capacity, and Trivy DB update
   frequency.
