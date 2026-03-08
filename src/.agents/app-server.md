# App Server and Extensible Secure Project Proxies (A1.4)

Status: active implementation spec; partially completed as of March 5, 2026.

## 1. Purpose

Define a single, extensible app/proxy system for CoCalc Lite and Launchpad that supports:

- private authenticated app access (default),
- optional public exposure,
- wake-on-demand runtime behavior,
- static site/file serving,
- clean base-path proxying,
- first-class CLI and agent control.

This should replace ad hoc per-app special cases over time.

## 1.1 Current Implementation Status (March 5, 2026)

### Done

1. App spec schema + validation and runtime state machinery are implemented.
2. Service app lifecycle API is implemented (`upsert/start/stop/status/restart/ensure-running/logs`).
3. Wake-on-demand for service apps is implemented.
4. Public expose/unexpose plumbing is implemented with TTL, random subdomain support, and optional front token auth.
5. Metered-egress warnings/policy hints (notably GCP) are implemented.
6. CLI surface for `workspace app` lifecycle is implemented and agent-usable in JSON mode.
7. Public-readiness audit command/prompt path is implemented (backend + CLI).
8. Live Launchpad GCP smoke for service app flow passes end-to-end (create/start/expose/public probe/recover/unexpose/cleanup).
9. The main user-facing app surface now uses `Apps` / `Managed Applications`, with duplicate launcher UI removed from `+New`, the `+New` flyout, and the old top-row launcher area.
10. Detection is split in the main UI between running HTTP-app discovery and installed-template discovery.
11. The Apps page now has real operational controls: filter/search, bulk start/stop, row-local startup failures, and a direct `Audit with Codex` action.

### Partial

1. Static app mode backend exists and the dedicated launchpad static-heavy smoke scenario (`apps-static`) now passes on live GCP; broader matrix (lite parity + larger cache/static variants) is still pending.
2. Cost guardrails are currently warning/policy-hint driven; deeper throttling/limits tuning remains.
3. The Apps page is coherent enough for real use now, but still needs visual/product polish, broader template coverage, and better advanced workflow presentation.
4. Static refresh jobs are implemented in an activity-driven first slice (run on first/stale hit with timeout + logs), but sandbox-ephemeral execution mode and richer scheduling policies are still pending.
5. App portability is partially implemented/planned: project clone should already carry app specs because they live in the workspace filesystem, and explicit CLI export/import/clone flows are being added; dedicated frontend download/upload UX is still pending.

### Not Done

1. Finalized static-mode smoke matrix (lite + launchpad, large-file/static cache cases).
2. "Install with agent" flow from app presets/management UI.
3. Broader template catalog and stronger embed/open integration polish.

## 2. Product Goals

1. One model for all app types.
2. Safe-by-default (private and authenticated).
3. Agent-usable via deterministic CLI.
4. Works with low-traffic, high-state scientific workloads.
5. Compatible with existing JupyterLab/code-server/Pluto workflows.
6. Expand CoCalc value from "private compute workspace" to "workspace + deployable services."

## 3. Non-Goals (for first pass)

1. Full Kubernetes-like orchestration semantics.
2. Cross-project global service mesh.
3. Multi-region failover for user apps.

## 4. Terminology

1. App Spec: user-declared configuration describing how to run and proxy an app.
2. App Runtime: current process/proxy/exposure status.
3. Private URL: authenticated URL requiring CoCalc auth token/cookies.
4. Public URL: optional internet URL (Cloudflare/external tunnel), explicit opt-in.
5. Wake-on-demand: start project/app on first request when currently cold.

## 5. Storage and Scope

### 5.1 Source of Truth for App Specs

Use project-local file specs so they are transparent and portable.

Proposed canonical location:

- `.local/share/cocalc/apps/<app-id>.yaml`

Rationale:

1. Matches XDG-style pathing.
2. Keeps app config colocated with project data.
3. Works with your suggestion to link `.local/share/cocalc` and `~/.cocalc` for convenience.

Optional compatibility:

1. Provide explicit `app export/import/clone` CLI for migration, backup, and agent workflows.

### 5.1.1 Portability, Import/Export, and Clone

App specs should be easy to move around without copying runtime state.

Requirements:

1. Export one app or all apps as JSON so users can download/share a config bundle.
2. Import one app spec or a multi-app bundle into another project.
3. Support direct app-spec clone between workspaces in the CLI so agents do not have to round-trip through local files.
4. Preserve only declarative app specs; do not clone runtime state, process state, logs, or public-exposure leases/tokens.
5. Make it clear that "clone project" is different from "clone app spec":
   - full project clone should already carry app specs automatically because the workspace filesystem clone includes `.local/share/cocalc/apps`,
   - runtime state and exposure metadata should still be re-created on first use in the destination environment.

Proposed portable bundle shape:

```json
{
  "version": 1,
  "kind": "cocalc-app-spec-bundle",
  "exported_at": "2026-03-07T00:00:00.000Z",
  "workspace_id": "source-workspace-id",
  "apps": [{ "...": "normalized app specs" }]
}
```

CLI/UI implications:

1. CLI:
   - `cocalc workspace app export <app-id>`
   - `cocalc workspace app export-all`
   - `cocalc workspace app import --file ...`
   - `cocalc workspace app clone <app-id> --from-workspace ... --to-workspace ...`
   - `cocalc workspace app clone-all --from-workspace ... --to-workspace ...`
2. Frontend:
   - download one app config or an all-app bundle,
   - upload/import a saved bundle,
   - eventually "Copy to another project" for direct in-product clone.

### 5.2 Runtime State

Runtime state should be in project-host metadata storage (project-host or lite hub sqlite), not in spec files.

State examples:

1. running/stopped/starting/error
2. discovered ports
3. last health-check
4. last start error
5. warm-until timestamp
6. public exposure metadata (if enabled)

Why:

1. Runtime state is operational, not user-authored content.
2. Keeps fast operational queries local to project-host.
3. Avoids churn in syncable project files.

## 6. App Spec Schema (Draft)

```yaml
version: 1
id: dask-gateway
title: Dask Gateway
kind: service # service | static
icon: appstore
command:
  exec: bash
  args: ["-lc", "dask-gateway-server --port 8787"]
  cwd: /home/user/project
  env:
    APP_BASE_URL: "${BASE_URL}"
network:
  listen_host: 127.0.0.1
  port: 8787
  protocol: http # http | https | ws
proxy:
  base_path: /apps/dask-gateway
  strip_prefix: true
  websocket: true
  iframe: auto # auto | force | never
  health_path: /health
  readiness_timeout_s: 45
wake:
  enabled: true
  keep_warm_s: 1800
  startup_timeout_s: 120
exposure:
  mode: private # private | public
  auth_front: none # none | token
  public:
    provider: cloudflare
    ttl_s: 86400
    random_subdomain: true
static:
  root: /home/user/project/site
  index: index.html
  cache_control: public,max-age=3600
```

Notes:

1. `kind=service` uses command + local listener + reverse proxy.
2. `kind=static` serves files directly from a configured path via project-host.
3. `BASE_URL` is computed by proxy layer and injected.

## 6.1 App Integration Layer

An app should not be modeled only as a runtime. In many cases we also want CoCalc-native integration on top of that runtime.

Model:

1. App Runtime:
   - how the backend service or native program is started and reached,
   - examples: proxied web app, static app, SSH/X11 native app.
2. App Integration:
   - how CoCalc files, UI actions, and project context are routed into that runtime,
   - examples: file-type handlers, lightweight sandboxed frontend bundle, deep links, identity/RTC glue.

This is a better long-term model than treating "extensions" as a fully separate product concept. In many cases the quickjs sandbox / extensions API should be the way an app integrates more deeply into CoCalc, not a competing parallel system.

Examples:

1. JupyterLab:
   - runtime: managed web app,
   - integration: clicking an `.ipynb` ensures JupyterLab is running and opens the correct file in a new tab or iframe with the needed user/session/RTC context.
2. code-server:
   - runtime: managed web app,
   - integration: future "Open with..." actions in the file explorer can route a file or directory into code-server.
3. PostgreSQL + web UI:
   - runtime: managed database plus a management UI,
   - integration: CoCalc can surface project-aware actions that jump directly into the database UI.
4. Chromium:
   - runtime: native/X11 app inside the workspace,
   - integration: CoCalc launches it in a safer sandboxed remote environment rather than on the user's own machine.

Possible future integration block in app specs:

```yaml
integration:
  file_types: [".ipynb"]
  open_with_label: "JupyterLab"
  mode: iframe # iframe | new-tab | native-launch
  sandbox_bundle: /path/to/bundle.js
  open_url_template: "${BASE_URL}/lab/tree/${FILE_PATH}"
```

Design implications:

1. the Apps page can eventually organize both runtime behavior and integration behavior,
2. app templates may include both a runtime preset and an integration preset,
3. file explorer "Open with..." is a natural later surface for these integrations,
4. the quickjs sandbox / extensions API should be viewed as an integration mechanism for apps, not just a separate plugin system.

## 7. Security Model

### 7.1 Default Private Access

1. App proxy URLs require authenticated CoCalc session/token.
2. Proxy auth token in URL is supported as a first-class mechanism (`?auth_token=...`) for app links and agent flows.
3. Token validation is centralized in proxy middleware.
4. Session-cookie auth remains supported for normal browser navigation.
5. No direct raw port exposure.

### 7.2 Upstream Constraints

1. Upstream target must be loopback (`127.0.0.1`/`localhost`) unless explicitly allowed by admin policy.
2. Enforce allowed protocols and sanitize headers.
3. Websocket upgrade support only through controlled proxy path.

### 7.3 Public Exposure

Public exposure is explicit and reversible.

1. User must opt in per app.
2. Warning UI explains visibility and cost implications.
3. TTL required (auto-expire unless renewed).
4. Revoke is immediate from UI/CLI.
5. Optional front token auth for convenience.
6. Randomized subdomain by default (defense-in-depth).
7. Optional "Audit with Codex" action in expose flow:
   - Launches an agent turn with a security/deployment checklist prompt.
   - Prompt includes CoCalc architecture context (proxy, token auth, base path, public URL scope, wake behavior).
   - Returns concrete findings and mitigation suggestions before final exposure.

### 7.4 Static Serving

1. Allow serving static paths from workspace via project-host.
2. Respect safe path constraints.
3. Optional aggressive caching headers for CDN cost control.

## 8. Wake-on-Demand Design

Wake-on-demand is especially important for public URLs and low-traffic apps.

Flow:

1. Request hits project-host proxy.
2. If project/app warm and healthy, proxy immediately.
3. If cold:
   - transition app state to `starting`,
   - start project runtime if needed,
   - start app command,
   - run readiness checks (port + health endpoint).
4. On success, proxy request.
5. On failure, return structured error page/json with logs pointer.

Controls:

1. `keep_warm_s` controls idle shutdown.
2. `startup_timeout_s` bounds user wait.
3. Optional queueing/concurrency guard prevents stampede starts.

## 9. Base URL and Proxy Compatibility

Many apps need path-prefix awareness.

Proxy must provide:

1. stripped prefix forwarding when configured,
2. forwarded headers (`X-Forwarded-*`, prefix info),
3. `APP_BASE_URL` env interpolation.

App health:

1. readiness path can be root or custom.
2. health failures surface clear diagnostics in UI/CLI.

### 9.1 Service Open Mode (`proxy` vs `port`)

Service specs must explicitly support two URL-open strategies:

1. `proxy` (default):
   - standard base-path reverse-proxy behavior,
   - strips proxy mount prefix before upstream forwarding.
2. `port`:
   - opens through the port-style route form used by existing CoCalc integrations,
   - for apps that do not behave correctly under stripped base-path proxying.

Product/UX requirements:

1. UI must explain this choice clearly where app specs are created/edited.
2. CLI must expose a deterministic explanation command and include `open_mode` in bootstrap examples.
3. Agent prompts should prefer `proxy`, but automatically suggest `port` when readiness/open checks show base-path incompatibility.

## 10. UI Plan

### 10.1 Entry Point Decision

App management should be separate from file creation.

Decision:

1. the left-nav button should be renamed from `Servers` to `Apps`,
2. the Apps page should become the single primary UI for managed apps,
3. remove app-launch UI from `+New`,
4. remove app-launch UI from the `+New` flyout panel,
5. keep customization for file creation and app management separate,
6. if needed, allow a lightweight shortcut into Apps, but not a second full app-creation workflow.

Alpha priority note:

1. Keep initial UI minimal and thin over CLI/API.
2. Main investment goes to backend lifecycle + CLI + agent integration first.

Rationale:

1. creating files and managing long-lived apps are different jobs,
2. duplicating app-launch UI across Apps, `+New`, and flyout creates drift in code and behavior,
3. one managed-app surface is easier for users, agents, and future policy controls.

Terminology:

1. left nav label: `Apps`
2. main page heading: `Managed Applications`
3. avoid `Servers` in user-facing copy where possible, since it is ambiguous and overly infrastructure-flavored.

### 10.2 Apps Page Structure

Project app panel with:

1. top toolbar:
   - template picker / new app,
   - search/filter,
   - bulk actions (`start all`, `stop all`, later selection-based actions),
2. managed app list:
   - status (running/starting/stopped/error),
   - private URL and optional public URL,
   - quick actions (start/stop/restart/expose/revoke/logs/edit),
   - last error snippet and health status inline on the same row/card,
3. no legacy top-row server launch buttons,
4. JupyterLab/code-server/Pluto/etc. should appear as first-party managed-app presets instead of a separate server system.

### 10.3 Detection Modes

Detection must be split into two distinct workflows:

1. detect running HTTP apps:
   - show candidate user applications that appear to be serving HTTP,
   - exclude infrastructure/system ports such as SSH and the project proxy itself,
   - ideally verify HTTP response before surfacing,
   - prompt: "We detected a running HTTP service on :XXXX. Create managed app?"
2. detect installed template apps:
   - check whether known templates are installed and runnable,
   - examples: JupyterLab, code-server, Pluto, RStudio, Streamlit, Gradio, TensorBoard,
   - use this to drive which presets are shown as ready-to-use vs install-needed.

### 10.4 Embedding

1. `iframe=auto` tries embedded view first.
2. if blocked by headers/policies, auto-fallback to external tab.
3. "Open in full tab" button always present.

### 10.5 Template Scope

Template catalog should be broader, but structured:

1. core built-ins:
   - JupyterLab
   - code-server
   - Pluto
   - RStudio
   - Static site
   - Python hello world
   - Node hello world
2. app/dev templates:
   - Streamlit
   - Gradio
   - Dash
   - Bokeh
   - TensorBoard
   - Dask dashboard
3. advanced:
   - custom command
   - native/X11 app
   - SSH-forwarded app
4. templates that are not installed should offer `Install with agent`.

## 11. CLI Plan (Agent-First)

Introduce `cocalc workspace app` command group with JSON-first output.

Core commands:

1. `cocalc workspace app list --json`
2. `cocalc workspace app get <app-id> --json`
3. `cocalc workspace app upsert --file spec.yaml --json`
4. `cocalc workspace app delete <app-id> --json`
5. `cocalc workspace app start <app-id> --wait --json`
6. `cocalc workspace app stop <app-id> --json`
7. `cocalc workspace app restart <app-id> --wait --json`
8. `cocalc workspace app logs <app-id> --tail 200`
9. `cocalc workspace app expose <app-id> --public --ttl 24h --json`
10. `cocalc workspace app unexpose <app-id> --json`
11. `cocalc workspace app ensure-running <app-id> --json`
12. `cocalc workspace app detect --json`
13. `cocalc workspace app audit <app-id> --public-readiness --json`
14. `cocalc workspace app export <app-id> --json`
15. `cocalc workspace app export-all --json`
16. `cocalc workspace app import --file app.json --json`
17. `cocalc workspace app clone <app-id> --from-workspace <src> --to-workspace <dst> --json`

Agent-critical behavior:

1. no interactive prompts by default in non-tty mode,
2. stable machine-readable fields (`status`, `url_private`, `url_public`, `error`),
3. explicit exit codes for health/start failures.
4. commands should expose actionable host/bandwidth policy hints (e.g., metered-egress warning on GCP).

## 12. Agent Workflow Requirements

When user asks: "Start Dask gateway" or "Run streamlit app", agent should be able to:

1. install necessary prerequisites (apt-get, pip, npm, etc.)
2. create or update spec,
3. start app and wait for readiness,
4. return reachable URL,
5. optionally expose publicly on request,
6. inspect logs and recover from failures.

This requires app lifecycle primitives to be first-class CLI operations, not ad hoc shell scripts.

## 13. Public Exposure Options

### 13.1 Minimal Mode

1. one-click public URL with random subdomain,
2. required TTL,
3. revoke anytime.
4. optional one-click Codex security audit before final confirmation.

### 13.2 Maximal Mode

Add optional controls:

1. front token/password gate,
2. custom hostname mapping,
3. cache policy presets,
4. warm policy tuning.

### 13.3 SSH Port-Forward Fallback (No Proxy-Rewrite Mode)

For difficult apps that fail under both `proxy` and `port`, add first-class SSH forwarding workflows.

Why this matters:

1. It bypasses HTTP path rewriting entirely.
2. It uses our already-hardened sshpiperd + Cloudflare tunnel path.
3. It gives users/agents a reliable escape hatch for non-cooperative services.
4. It naturally extends beyond web apps to native/X11 applications that have no useful browser deployment path.

### 13.3.1 Native/X11 App Extension

This SSH-based fallback should also support native GUI applications, especially:

1. simple X11 test apps such as `xclock`,
2. legacy scientific visualization tools with no serious web counterpart,
3. desktop-style editors such as Zed or similar tools that are better launched locally than proxied through a browser.
4. a full web browser such as chromium -- it can be useful having it run directly inside the workspace

Conceptually, this is a second app-launch mode:

1. managed web app:
   - start service in workspace,
   - expose through CoCalc proxy/public URL machinery.
2. managed native app:
   - start through SSH/X11 workflow,
   - no HTTP proxying required,
   - UI gives the user a generated local bootstrap command instead of a web URL.

User flow:

1. configure a native app spec or choose a native-app preset,
2. click launch,
3. CoCalc shows a small generated bootstrap command,
4. user pastes it into a terminal on their laptop,
5. the command:
   - ensures `cocalc-cli` is installed or upgraded,
   - ensures SSH access is configured,
   - sets up SSH forwarding/X11 transport,
   - launches the requested application against the project.

This is especially valuable because it lets CoCalc manage the remote environment while still using native local rendering/input for apps that do not belong in a browser.

Platform scope for first pass:

1. Linux desktop first, since X11 forwarding is straightforward there.
2. macOS and Windows should be explicitly documented as requiring additional local prerequisites and may initially be unsupported or best-effort only.
3. Generated commands should be OS-aware and fail early with a clear prerequisite message if the local machine is missing required pieces.

### 13.3.2 Daemon-Assisted Local Launch and Forwarding

Longer term, the local `cocalc-cli` daemon should become the preferred control plane for SSH port forwarding and native app launch.

Why this is attractive:

1. the daemon already exists to maintain persistent websocket connectivity to project-hosts,
2. it can own local process lifecycle for forwarded ports and launched apps,
3. it avoids fragile copy/paste commands and shell-quoting problems,
4. it provides a natural place for local approval prompts, retries, cleanup, and status reporting.

Preferred flow:

1. user installs `cocalc-cli` and authenticates at an appropriate control level,
2. CoCalc detects that a paired local daemon is available,
3. when the user clicks `Port Forward (SSH)` or `Launch on my computer`, CoCalc sends a typed request to the daemon,
4. the daemon shows a native popup approval dialog describing exactly what local action will happen,
5. upon approval, the daemon performs the SSH setup and either:
   - starts the local port forward, or
   - launches the requested native application.

Approval dialog should include:

1. workspace/project identity,
2. remote target details,
3. local port or local application being launched,
4. expected duration/persistence,
5. whether the action is one-shot or remembered for the current session/project.

Security model:

1. daemon requests must be narrowly typed capabilities, not arbitrary shell commands,
2. examples:
   - "forward remote port 8787 to local 127.0.0.1:8877",
   - "launch `xclock` over approved SSH/X11 session",
3. every action should be attributable to a signed-in user and a specific project/workspace,
4. there should be a local audit trail and one-click stop/revoke path,
5. copy/paste bootstrap remains the low-trust fallback when daemon pairing is unavailable.

Product tiers of trust:

1. low trust:
   - copy/paste only,
   - no daemon control.
2. medium trust:
   - daemon available,
   - explicit approval for every action.
3. higher trust:
   - daemon may remember approval for a given project/session for a short period,
   - still no unrestricted arbitrary local execution.

This makes the system feel dramatically smoother while keeping the right security boundary: the daemon is a typed local agent, not a general remote shell.

CLI shape (proposed):

1. `cocalc workspace app ssh-forward <app-id> --local-port 8888 [--remote-port auto] --json`
   - ensures workspace/project runtime is reachable for SSH,
   - resolves app target port (or accepts explicit),
   - outputs ready-to-run local command and connection metadata.
2. `cocalc workspace app ssh-forward-command <app-id> --local-port 8888`
   - prints a single copy/paste command for local laptop execution.
3. `cocalc workspace app ssh-forward stop <session-id>`
   - optional if we manage background local helpers from CLI wrappers.
4. `cocalc workspace app launch-native <app-id> --json`
   - returns a generated local bootstrap command instead of a URL,
   - includes platform/prerequisite metadata so UI and agent can explain what will happen.

Agent workflow:

1. Try `proxy` mode first.
2. If health/open checks fail and logs indicate base-path mismatch, try `port`.
3. If still failing, suggest SSH forwarding with explicit command.
4. Return a short explanation:
   - "this app is not proxy-compatible; using direct SSH forwarding."
5. For declared native apps, skip web-proxy steps entirely and return the generated local launch command.

UI behavior:

1. In app details/actions, add "Port Forward (SSH)".
2. Show one-click copy command and brief trust/scope note.
3. Keep this private by default and separate from public exposure controls.
4. For native apps, use language such as "Launch on my computer" instead of "Open".

Security/ops constraints:

1. SSH forwarding remains user-authenticated and project-scoped.
2. No new public URL is created by default.
3. Log forwarding sessions in project-host activity state for auditability.
4. Provide explicit stop/cleanup guidance for long-running forwards.
5. Native launch helpers must remain thin wrappers around SSH/CLI setup and app launch, not arbitrary local installer scripts.

## 14. Static Site Mode

Support static hosting for large dataset-backed websites.

Requirements:

1. serve directory tree from app spec,
2. optional index fallback,
3. efficient range requests for large files,
4. cache-control configuration,
5. optional public mode with CDN edge caching.
6. support "static-only app" without process launch (directory served directly by project-host).

## 14.1 Activity-Driven Static Refresh Jobs

Support optional static refresh commands so generated/static artifacts can be kept fresh without wasting compute.

Implemented (first slice):

1. Optional `static.refresh` block in app spec:
   - `command` (`exec/args/cwd/env`)
   - `timeout_s`
   - `stale_after_s`
   - `trigger_on_hit`
2. Refresh command runs:
   - on first hit (no prior successful run), and
   - on later hits only when stale (`now - last_success >= stale_after_s`).
3. No background cron loop in first slice:
   - avoids idle cost explosions when nobody visits,
   - naturally scales refresh cadence with real traffic.
4. Last refresh stdout/stderr is exposed through app logs/status for debugging.
5. UI fields in Managed App Server panel allow configuring refresh command + stale/timeout + on-hit toggle.

Not yet implemented:

1. Running refresh in a dedicated sandbox-ephemeral container mode (current implementation runs in the project runtime).
2. Advanced policies (e.g., periodic windows with traffic thresholds, queued warm/cold precompute strategies).

## 14.2 Cost and Policy Guardrails

Guardrails should be host-aware and practical, not generic.

1. Cloud/provider-aware egress policy:
   - free-egress hosts: relaxed defaults,
   - metered-egress hosts (notably GCP): stricter defaults, warnings, and throttles.
2. Cloudflare caching policy presets for static/public content (strong recommendation by default).
3. Public exposure flow should display an estimated risk profile:
   - traffic risk (low/medium/high),
   - caching configured or not,
   - metered egress warning if applicable.
4. Membership-aware policy hooks:
   - not pay-as-you-go by default for end users,
   - server/app limits can follow membership tier,
   - users on self-paid hosts may be allowed effectively unlimited app servers on that host (subject to safety limits).
   - for metered-egress hosts, enforce stronger defaults/throttles even for high-tier plans.
5. Optional recommendation engine:
   - if on metered-egress host and public traffic expected, suggest moving to free-egress host.

## 15. API/Backend Components

Needed backend modules:

1. spec loader/validator
2. runtime state manager (project-host sqlite)
3. process supervisor bridge
4. secure proxy registry/router
5. exposure manager (Cloudflare integration)
6. detector for local HTTP listeners
7. cost policy evaluator (host/cloud/egress-aware recommendations and limits)
8. audit prompt builder for Codex app-security checks

Existing components to reuse where possible:

1. project-host proxy machinery
2. token/auth middleware
3. cloudflare tunnel integration path
4. host operation/status framework

## 16. Rollout Plan (Backend/CLI First)

### Phase 0: Foundations (Status: done)

1. spec schema + validation
2. private proxy registration
3. start/stop/status runtime state
4. CLI `list/get/upsert/start/stop/status/ensure-running`
5. wake-on-demand implementation for private routes

### Phase 1: Public Alpha-Safe Slice (Status: mostly done)

1. public exposure with required TTL + revoke
2. random subdomain default
3. optional front token auth
4. metered-egress guardrails + warnings
5. static site mode + cache presets
6. optional pre-expose Codex audit action

### Phase 2: Agent and CLI Deepening (Status: partial)

1. complete CLI surface (`detect`, `audit`, `expose`, `unexpose`, `logs`)
2. agent-ready workflows and prompts for app lifecycle
3. end-to-end tests for agent-driven startup/exposure/recovery
4. add UI handoff actions for "install this server/app with agent" (preset-aware prompts)

### Phase 3: UI Expansion (after backend confidence) (Status: not started)

1. Apps page becomes the single managed-app surface
2. remove duplicated app-launch UI from `+New` and flyout
3. app management panel polish
4. split autodetection into running-HTTP vs installed-template UX
5. iframe auto-fallback polish
6. expand template catalog and `Install with agent`

## 17. Acceptance Criteria (A1.4)

1. New app specs can be created declaratively and launched without custom code edits.
2. Private URL access is authenticated and secure by default.
3. `cocalc workspace app ...` commands fully cover lifecycle in JSON mode.
4. Base path support works for at least JupyterLab, code-server, and one custom app.
5. Wake-on-demand works for stopped app and returns usable URL after startup.
6. Public exposure is explicit, revocable, and TTL-bound.
7. Static site serving supports large files and cache headers.
8. CLI and agent can fully manage app lifecycle without requiring UI.
9. Public expose flow supports optional Codex audit step.

## 18. Open Questions

1. Should default spec location be only `.local/share/cocalc/apps`, or dual-path with optional `.cocalc/apps` export?  Ans: I think `.local/share/cocalc/apps to avoid confusion.`
2. For public mode, should front-token auth be enabled by default or optional?  Ans: optional.
3. What is the best default `keep_warm_s` for public endpoints? Ans: No idea; user wants infinite; we want small to save money -- it can be a configurable parameter that depends on the user's membership level, with a default right now of "300" (5 minutes). 
4. Should app state changes emit user-visible activity log events by default? Ans: yes, at least in the sense that they should have access.
5. How strongly should we couple app runtime state with project-host restarts?  Ans: I think strongly, just like with projects.
6. Membership policy defaults: what app/public-expose limits per tier?  Ans: just make them some generic numbers and site admins will tweak them.   Params should include: (1) number of apps, (2) keep_warm_s, (3) egress on non-free hosts.
7. Should Codex pre-expose audit be default-on or explicit optional? Ans: default on.

## 19. Implementation Checklist (Initial)

1. `[done]` Finalize spec path and schema (including static mode fields).
2. `[done]` Add backend validator + runtime store model in project-host sqlite.
3. `[done]` Implement private proxy registration and lifecycle API.
4. `[done]` Implement wake-on-demand start path with readiness checks.
5. `[done]` Add CLI lifecycle commands with stable JSON output (agent-first).
6. `[done]` Add public exposure controls (TTL/revoke/random subdomain + optional front token).
7. `[partial]` Add host-aware cost guardrails (especially metered-egress behavior). (NOTE: egress is the primary special-cost driver here.)
8. `[partial]` Add static file serving mode with cache presets.
9. `[done]` Add Codex app audit prompt/action path for public expose (backend, CLI, and Apps-page action are implemented).
10. `[partial]` Add end-to-end tests in lite and launchpad for service and static cases (service launchpad smoke done; live GCP `apps-static` smoke passes; lite parity + broader static matrix pending).
11. `[done]` Rename the left-nav button from `Servers` to `Apps` and use `Managed Applications` as the main page heading.
12. `[done]` Make Apps page the single managed-app surface and remove duplicated app-launch UI from `+New` and flyout.
13. `[done]` Remove legacy top-row server launcher UI and map JupyterLab/code-server/etc. to managed-app presets.
14. `[done]` Split detection into running-HTTP discovery vs installed-template discovery.
15. `[done]` Add filter/search plus bulk actions (`start all`, `stop all`, later selection-based actions).
16. `[done]` Move startup errors/logs/actions to the corresponding app row/card instead of global top-of-page alerts.
17. `[todo]` Add "Install with agent" from app presets and app rows (with suggested install prompts and post-install verification/start).
18. `[todo]` Add SSH port-forward fallback in CLI + UI for non-proxy-compatible apps.
19. `[todo]` Audit managed-app XSS exposure specifically for CoCalc credentials/session material (cookie stripping, project-host session scope, private same-origin app behavior, static HTML assumptions).
20. `[partial]` Add app portability workflows:
   - explicit CLI export/import/clone,
   - document that full project clone already carries app specs because they live in the workspace filesystem,
   - frontend download/upload/"copy to another project" UX still pending.

## 19.1 Next Execution Order

1. Run and harden launchpad `apps-static` smoke in live cloud loop, then add lite static parity and broader static matrix.
2. Rename `Servers` to `Apps` and use `Managed Applications` as the primary page language.
3. Collapse Apps / `+New` / flyout app entry points into one Apps-first surface.
4. Remove legacy top-row server launcher UI and map built-ins to managed-app presets.
5. Split detection into running-HTTP discovery vs installed-template discovery.
6. Add filter/search/bulk-actions and row-local error handling.
7. Add pre-expose "Audit with Codex" UI action, likely using the same style/pattern as the new in-progress agentized Help-me-fix flow.

## 19.2 Strict Remaining Queue

### Alpha-blocking

These are the remaining items that matter most to calling A1.4 effectively finished as a coherent product feature.

1. finish static-mode validation:
   - harden launchpad `apps-static`,
   - add lite parity,
   - cover broader static/cache cases.
2. finish the last Apps-page polish needed for alpha:
   - tighten copy/labels,
   - improve layout density and preset presentation,
   - smooth remaining rough edges in error/display behavior.
3. do a focused XSS/origin-isolation audit for managed apps:
   - verify which CoCalc cookies or bearer mechanisms can ever reach private app requests,
   - verify which cookies are stripped before upstream proxying,
   - done: strip project-host auth/session cookies before forwarding traffic upstream to the managed app,
   - done: scope the project-host session cookie as narrowly as possible instead of using a broad path,
   - audit project-host session-cookie scope/path/domain behavior,
   - determine whether additional per-project/per-app origin isolation is required for private apps,
   - harden static HTML serving assumptions accordingly.
4. change Cloudflare public-app routing so traffic bypasses the central hub and goes directly to the target project-host:
   - the current implementation points public app hostnames at the same Cloudflare/site target as the main site and then relies on hub-side hostname rewrite + proxying,
   - this is a blocker because it adds unnecessary latency and, on metered providers such as GCP, can double backhaul traffic and create unacceptable egress cost,
   - public app DNS/tunnel resolution should instead target the owning project-host directly,
   - the project-host should remain responsible for host-based public-app auth/routing without requiring the central hub in the request data path,
   - verify both HTTP and websocket traffic follow the direct project-host path.

### Post-alpha

These improve the product substantially, but do not need to block first public release.

1. broader template catalog and better preset organization.
2. `Install with agent` from presets and app rows.
3. deeper host-aware egress guardrails beyond warnings/policy hints.
4. richer static refresh policy options and sandbox-ephemeral execution.
5. iframe/embed polish and better "open in full tab" fallback behavior.
6. frontend import/export/"copy to another project" workflows for app configs.

### Longer-term platform work

These are real extensions of the Apps platform, but are clearly beyond the first finish line.

1. SSH port-forward fallback UI/CLI completion.
2. native/X11 app support.
3. daemon-assisted local launch and forwarding via `cocalc-cli`.
4. app integration layer:
   - file-type handlers,
   - future `Open with...` actions in the file explorer,
   - quickjs/extensions-backed frontend integration.
5. tighter policy/membership integration for app/public-expose limits.
6. possible convergence of apps plus CoCalc-integrated extension bundles into a broader Apps platform.

## 20. Alpha-Safe Public Model (Minimum to Ship)

This is the strict minimum public model to launch confidently without over-building:

1. Private-by-default app proxy with centralized token/session auth.
2. Public exposure requires explicit action, required TTL, and immediate revoke.
3. Random subdomain default and clear warning copy.
4. Wake-on-demand with bounded startup timeout and clear error states.
5. Static mode with cache presets for public content.
6. Host-aware egress warning/guardrail for metered providers.
7. Full lifecycle available via CLI so agents can operate it end-to-end.
8. Optional Codex pre-expose audit button with architecture-aware prompt.
