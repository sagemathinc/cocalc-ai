# Site Setup Checklist/Wizard Plan, 2026-05-30

Status: `open`

Purpose: turn the validated Launchpad/Rocket first-run setup sequence into a
guided admin setup shell with hard gates, concrete health checks, and minimal
opportunity for wrong turns.

This plan intentionally starts rough but well-defined. The first milestone is a
plain, reliable wizard/checklist. Visual polish, stronger motion/design, and
imagegen-assisted refinement should come after the flow is functionally correct.

## Problem Statement

Fresh Launchpad/Rocket setup now works, but the successful path is hidden inside
separate admin pages and several operational assumptions. A new operator can
easily take distracting wrong turns:

- Configure cloud providers before the public URL and Cloudflare path works.
- Paste large credential blobs instead of using direct upload.
- Skip 2FA, then hit admin actions that fail fresh-auth or 2FA checks.
- Create a project host before host software artifacts are served from the
  correct site-local `/software` endpoint.
- Miss email setup and later discover account recovery/invite flows are broken.
- Create hosts without an official/prepulled RootFS, causing slow or confusing
  first project starts.

The product needs a single, ordered first-run setup experience that exposes the
real dependency graph and tests each dependency before allowing the next critical
step.

## Product Goal

When a new Launchpad/Rocket site is installed, the first admin should land in a
dedicated setup shell that guides them from "bare site" to "usable production or
dogfood site" with:

- clear ordered steps,
- hard gates where later work cannot succeed without earlier work,
- direct validation against the real public endpoint and provider APIs,
- links into existing admin pages where those pages are still the right tool,
- and a final smoke test that proves projects actually work.

The normal CoCalc app should remain accessible through an explicit escape hatch,
but the admin dashboard should keep surfacing setup status until all critical
checks pass.

## Validated Correct Path

The current known-good sequence is:

1. Install Launchpad or Rocket.
2. Create the first admin account and set up 2FA.
3. Configure Cloudflare and verify the public site URL works.
4. Configure GCP and/or Nebius using direct-upload CLI wizards.
5. Configure an email provider, or explicitly accept degraded behavior.
6. Create the first project host.
7. Create and publish an official RootFS, then prepull it on hosts.
8. Run a smoke test: create project, start project, open terminal, verify RootFS.

## V1 Design Principles

### 1. Derive State Where Possible

Avoid a new source-of-truth table for setup progress in V1. Compute step status
from existing settings, accounts, hosts, provider config, rootfs catalog, and
health checks.

Persist only operator choices that cannot be derived, such as:

- "email intentionally skipped for now",
- "setup shell dismissed",
- "custom smoke-test project id",
- "last setup check result cache" if needed for expensive checks.

### 2. Hard Gates, Not Just Checklist Cosmetics

Each step should expose:

- `blocked`: prerequisites are missing.
- `ready`: prerequisites pass and action can start.
- `running`: the action or check is in progress.
- `done`: validation passed.
- `warning`: usable but degraded.
- `failed`: validation failed with a next action.
- `skipped`: explicitly skipped where allowed.

The UI should not offer actions that are known to be invalid yet. It should show
why they are blocked and which previous step fixes the block.

### 3. Validate The Next Dependency

Every step should test the thing that the following step depends on. Examples:

- Cloudflare step validates `https://site/api/v2/auth/bootstrap`, not only that
  settings are present.
- Provider setup validates direct-upload receipt, stored provider config, and a
  catalog refresh.
- First host step validates software base URL, bootstrap artifact URLs, and host
  heartbeat.
- RootFS step validates official catalog visibility and host prepull state.

### 4. Direct Upload Only For Normal Provider Setup

GCP and Nebius setup should use direct upload as the normal and only visible V1
path. Manual paste can remain as a hidden dev/support fallback behind an
advanced flag if needed, but it should not be part of the standard wizard.

Reason: if the site is not publicly reachable enough for direct upload, external
GCP/Nebius project hosts are not going to work reliably either.

### 5. Keep Existing Admin Pages Useful

The wizard should not duplicate every detailed admin UI. It should orchestrate
the setup path and deep-link to existing pages/modals for detailed editing.

## Setup Shell UX

### Entry Points

- After first admin signup, route admins to `/admin/setup` if critical setup is
  incomplete.
- Add an Admin sidebar item: `Site Setup`.
- Add a persistent Admin dashboard banner while critical setup is incomplete.
- Add a non-destructive `Exit setup for now` button that returns to the normal
  app but does not mark setup complete.

### Layout

V1 can be plain:

- left column: ordered step list with status badges,
- right column: selected step details, action button, validation output,
- top summary: "Site is not ready", "Site is usable with warnings", or "Site is
  ready",
- bottom: final smoke-test panel.

No custom visual design is required for V1 beyond making status and blocking
reasons obvious.

### Step Behavior

Each step detail panel should include:

- what this step enables,
- current status,
- exact missing prerequisites,
- primary action button,
- validation result with timestamp,
- link to the underlying admin page,
- relevant logs or last error when available.

## Step Definitions

### Step 1: Admin Account And 2FA

Goal: ensure the first operator can perform dangerous admin actions safely.

Derived status:

- `done` if current account is admin and has 2FA enabled.
- `warning` if current account is admin but 2FA is missing.
- `blocked` if current account is not admin.

Actions:

- Open 2FA setup.
- Recheck account security.

Hard gate:

- Block Cloudflare, provider setup, host creation, and rootfs publishing until
  the current admin has 2FA.

Implementation notes:

- Reuse existing account 2FA state.
- Prefer existing fresh-auth/2FA requirements rather than inventing new auth.

### Step 2: Public URL And Cloudflare

Goal: make the site externally reachable and suitable as the base URL for
provider setup, project-host callbacks, and direct-upload wizards.

Derived status:

- `blocked` if admin 2FA is missing.
- `ready` if Cloudflare settings are absent.
- `running` while tunnel apply/check is in progress.
- `done` if settings exist and public URL checks pass.
- `failed` if settings exist but public checks fail.

Validation:

- Resolve configured public URL.
- Fetch `GET <public-url>/`.
- Fetch or post a lightweight API endpoint, ideally
  `POST <public-url>/api/v2/auth/bootstrap`.
- Verify returned `home_bay_url` or equivalent public site URL matches the
  configured public URL.
- Verify the site is not returning a stale different host, e.g. old
  `demo.cocalc.ai` values.

Actions:

- Open Cloudflare setup wizard.
- Apply Cloudflare tunnel settings without restarting hub.
- Recheck public reachability.

Hard gate:

- Block cloud provider setup until this passes, because direct upload and
  project hosts depend on public reachability.

### Step 3: Cloud Provider Config

Goal: configure at least one project-host provider.

Supported providers for V1:

- GCP
- Nebius

Derived status:

- `blocked` if public URL/Cloudflare checks fail.
- `ready` if no provider is configured.
- `warning` if a provider is configured but catalog is empty or stale.
- `done` if at least one provider is configured and catalog has entries.

Actions:

- Start GCP direct-upload flow.
- Start Nebius direct-upload flow.
- Refresh provider catalog.
- Recheck provider status.

Direct upload rules:

- The visible wizard should show only direct upload.
- The command should upload to the current public URL.
- The browser should poll for upload completion.
- The user reviews parsed config and clicks Apply.
- The raw provider secret should not be echoed in the terminal on success.

Validation:

- Stored provider config exists.
- Provider setup script endpoint works:
  - `/project-host/gcp-setup.sh`
  - `/project-host/nebius-setup.sh`
- Provider catalog refresh either completes or continues polling through long
  provider API calls.
- Catalog contains regions/zones/machine types/prices sufficient to create a
  host.

Hard gate:

- Block first project-host creation until at least one provider is configured
  and has a usable catalog.

### Step 4: Email Provider

Goal: enable account recovery, notifications, invites, and operational email.

Derived status:

- `done` if an email provider is configured and a test send succeeds.
- `warning` if email is explicitly skipped.
- `ready` if not configured and not skipped.

Actions:

- Open email provider settings.
- Send test email.
- Skip email for now.

Hard gate:

- Do not block dogfood/dev use if skipped explicitly.
- For production mode, strongly recommend making this a hard gate unless a
  product decision says otherwise.

Open product question:

- Investigate Cloudflare-based email or another simpler default path to reduce
  the number of external accounts required.

### Step 5: First Project Host

Goal: create one healthy project host and prove host bootstrap converges.

Derived status:

- `blocked` if no usable provider catalog exists.
- `ready` if no project host exists.
- `running` if a host create/bootstrap LRO is active.
- `done` if at least one host is running and heartbeating.
- `failed` if the last bootstrap failed.

Validation before VM creation:

- `COCALC_PROJECT_HOST_SOFTWARE_BASE_URL_FORCE` or effective software base URL
  points at the intended site-local `/software` endpoint for Rocket.
- Fetch current software endpoints:
  - `/software/bootstrap/latest/bootstrap.py`
  - `/software/project-host/latest-linux.json`
  - `/software/project/latest-linux.json`
  - `/software/tools/latest-linux-amd64.json`
- Check bootstrap constants are current enough to avoid known stale artifacts.
  For example, current bootstrap should not hardcode legacy runtime
  `1002:1003`.

Validation after VM creation:

- Host bootstrap LRO completes or reports actionable status.
- Host heartbeat appears.
- Host runtime page reports healthy services.
- Host can accept a trivial project start.

Actions:

- Open create-host modal with provider preselected.
- Reconcile failed host software.
- Delete/retry failed bootstrap host where safe.

Hard gate:

- Block RootFS prepull and final smoke test until a healthy host exists.

### Step 6: Official RootFS

Goal: provide a known-good project image that is visible and prepulled for users.

Derived status:

- `blocked` if no healthy project host exists.
- `ready` if no official image exists.
- `running` if rootfs publish/prepull LRO is active.
- `done` if at least one official image is visible and prepulled on the first
  host.

V1 default recipe:

```sh
apt update
apt install -y jupyter latexmk dpkg-dev curl wget
```

Candidate base image used in testing:

```text
ubuntu:26.04
```

Actions:

- Create rootfs image from a project.
- Mark/publish as official.
- Prepull on all hosts.
- Recheck rootfs availability.

Validation:

- Official image appears in rootfs catalog.
- First project host has cached/prepulled image.
- New project creation can select or default to this image.

### Step 7: Final Smoke Test

Goal: prove the site is actually usable, not just configured.

Derived status:

- `blocked` until provider, host, and rootfs steps pass.
- `running` while smoke test is active.
- `done` if all checks pass.
- `failed` with detailed failed substep.

Smoke test:

1. Create a project on the first healthy host.
2. Start it using the official RootFS.
3. Open project files.
4. Open a terminal and run a tiny command, e.g. `python3 --version`.
5. Optional: create/open a Jupyter notebook if Jupyter is included.
6. Verify project stop/start works.

The smoke test can initially be manual with clear checklist buttons. Later it
should become an automated LRO.

## Backend Shape

### New Conat API Surface

Add a focused setup API rather than scattering setup state across unrelated UI
calls.

Candidate subject/service:

- `system.getSiteSetupStatus`
- `system.runSiteSetupCheck`
- `system.setSiteSetupChoice`
- `system.startSiteSetupSmokeTest`

Return shape:

```ts
type SiteSetupStatus = {
  overall: "blocked" | "ready" | "warning" | "done";
  public_url?: string;
  steps: SiteSetupStep[];
  updated_at: string;
};

type SiteSetupStep = {
  id:
    | "admin_2fa"
    | "cloudflare"
    | "provider"
    | "email"
    | "project_host"
    | "rootfs"
    | "smoke_test";
  status: "blocked" | "ready" | "running" | "done" | "warning" | "failed" | "skipped";
  title: string;
  summary: string;
  blocking_reason?: string;
  action_label?: string;
  action_href?: string;
  last_checked_at?: string;
  last_error?: string;
  details?: Record<string, unknown>;
};
```

Implementation guidance:

- Keep checks read-only unless the method name clearly starts an action.
- Keep expensive external checks opt-in via `runSiteSetupCheck`.
- Cache expensive check results briefly if needed.
- Require admin and fresh auth where appropriate.
- Require 2FA for mutation/action methods after the 2FA gate.

### Persisted Setup Choices

Use existing settings or a small JSON setting for V1:

```ts
site_setup_state: {
  email_skipped_at?: string;
  setup_dismissed_at?: string;
  smoke_test_project_id?: string;
}
```

Avoid a new table until we need multi-operator audit/history.

## Frontend Shape

### New Route

Add an admin route:

- `/admin/setup`

Likely files:

- `src/packages/frontend/admin/site-setup/...`
- route integration wherever admin site-settings routes are registered.

### Components

V1 components:

- `SiteSetupPage`
- `SetupProgressSummary`
- `SetupStepList`
- `SetupStepPanel`
- `SetupValidationLog`
- provider-specific direct-upload cards reused from existing settings wizards

The page should be intentionally plain until the flow is correct.

### Navigation Integration

- First admin account signup should redirect to setup if setup is incomplete.
- Admin dashboard should show a setup banner when incomplete.
- Existing Cloudflare/GCP/Nebius/email/rootfs/host pages should link back to
  setup after successful configuration.

## Implementation Phases

### Phase 1: Read-Only Setup Status

Deliverable:

- `/admin/setup` page with computed status for all steps.
- No new mutations except reusing existing links.
- Admin dashboard banner.

Checks:

- Admin 2FA derived correctly.
- Cloudflare/public URL status derived or checked manually.
- Provider config and catalog status visible.
- Host/rootfs/email status visible.

Validation:

- Unit tests for status derivation.
- Manual test on `delta.cocalc.ai`.

### Phase 2: Hard Gates And Direct Actions

Deliverable:

- Disable or block invalid next actions in the setup shell.
- Add "Run check" buttons for Cloudflare, provider catalog, software base URL,
  host heartbeat, and rootfs prepull.
- Make GCP/Nebius direct upload the normal visible path.

Validation:

- New site with no Cloudflare blocks provider setup.
- Site with Cloudflare passes provider direct upload.
- Provider catalog refresh handles long backend calls without stale modal state.

### Phase 3: First Host And RootFS Guided Flow

Deliverable:

- Setup shell can drive first host creation via existing host create modal.
- RootFS step links to the right project/rootfs workflow and validates official
  image/prepull state.
- Host software base URL preflight warns before VM creation if it points at
  public R2 unexpectedly for Rocket.

Validation:

- Fresh dogfood site can create first GCP host.
- Fresh dogfood site can create first Nebius host.
- Failed bootstrap errors are surfaced with the real bootstrap tail.

### Phase 4: Smoke Test

Deliverable:

- Manual smoke-test checklist first.
- Automated smoke-test LRO later if the manual version proves useful.

Validation:

- Creates project on healthy host.
- Starts project with official RootFS.
- Terminal and optional Jupyter checks pass.

### Phase 5: Design Polish

Deliverable:

- Improve setup shell visual design after V1 correctness.
- Use imagegen2 or other design exploration for a polished first-run experience.

Constraint:

- Do not polish before the step model and checks are stable.

## Testing Plan

Unit tests:

- setup status derivation from mocked settings/accounts/hosts/rootfs.
- gate transitions for each missing prerequisite.
- direct-upload-only provider UI state.

Integration tests:

- Cloudflare check against local mocked public URL.
- provider catalog refresh with delayed backend completion.
- host software base URL resolution for Rocket and Launchpad.

Manual dogfood tests:

- Clean Rocket bay setup.
- Clean Launchpad setup.
- GCP-only provider setup.
- Nebius-only provider setup.
- both providers configured.
- email skipped.
- email configured.
- first host bootstrap failure and retry.
- official RootFS publish/prepull.

## Non-Goals For V1

- Fully automating VM creation for the bay itself.
- Replacing every admin settings page.
- Making Cloudflare setup fully automatic.
- Requiring email for dogfood/dev sites.
- Building the final polished visual design.
- Solving all multi-bay routing setup. V1 should be compatible with multibay,
  but the first implementation can guide bay-0 first and add bay-1 checks later.

## Open Questions

1. Should production mode make email a hard gate while dogfood/dev mode allows
   explicit skip?
2. Should setup completion be a derived state only, or should admins explicitly
   click "Mark site ready" after the smoke test?
3. Should first-run setup be shown to all admins or only owner/superadmin
   accounts?
4. Should direct-upload manual paste fallback be hidden behind an env flag or an
   "advanced support mode" link?
5. What should the default official RootFS recipe be for a public release?

## Success Criteria

The plan is successful when a new operator can set up a fresh Launchpad/Rocket
site by following one page, in order, without reading source code or asking for
the hidden correct sequence.

Operationally, a successful setup ends with:

- admin account has 2FA,
- public URL works,
- Cloudflare tunnel works,
- at least one provider is configured by direct upload,
- provider catalog is loaded,
- email is configured or explicitly skipped,
- at least one project host is healthy,
- at least one official RootFS is visible and prepulled,
- a smoke-test project starts and exposes terminal/Jupyter functionality.
