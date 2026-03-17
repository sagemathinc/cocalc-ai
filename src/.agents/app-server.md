# App Server and Extensible Secure Project Proxies (A1.4)

Status: active implementation spec; materially further along as of March 17, 2026.

Recent product note (March 17, 2026):

1. `Install with Codex` from the Apps UI is now good enough for real use on tested templates.
2. New navigator threads created by install/audit handoff now get explicit titles instead of inheriting the full prompt body.
3. When a template has curated install recipes, the prompt builder now biases Codex toward those recipes instead of anchoring on a generic one-line command.
4. The built-in JupyterLab template now steers Codex to the tested Ubuntu `apt + pip` path, and that flow has been verified on fresh Launchpad projects.
5. Remaining work is broader curated-template coverage, more install verification across images/templates, and snapshot/result-polish around the install flow.

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
6. CLI surface for `project app` lifecycle is implemented and agent-usable in JSON mode.
7. Public-readiness audit command/prompt path is implemented (backend + CLI).
8. Live Launchpad GCP smoke for service app flow passes end-to-end (create/start/expose/public probe/recover/unexpose/cleanup).
9. The main user-facing app surface now uses `Apps` / `Managed Applications`, with duplicate launcher UI removed from `+New`, the `+New` flyout, and the old top-row launcher area.
10. Detection is split in the main UI between running HTTP-app discovery and installed-template discovery.
11. The Apps page now has real operational controls: filter/search, bulk start/stop, row-local startup failures, and a direct `Audit with Codex` action.
12. `Install with Codex` is implemented from the Apps UI, with preset-aware prompts, explicit new-thread titles, and stronger preference for curated install recipes when available.

### Partial

1. Static app mode backend exists and the dedicated launchpad static-heavy smoke scenario (`apps-static`) now passes on live GCP; broader matrix (lite parity + larger cache/static variants) is still pending.
2. Cost guardrails are currently warning/policy-hint driven; deeper throttling/limits tuning remains.
3. The Apps page is coherent enough for real use now, but still needs visual/product polish, broader template coverage, and better advanced workflow presentation.
4. Static refresh jobs are implemented in an activity-driven first slice (run on first/stale hit with timeout + logs), but sandbox-ephemeral execution mode and richer scheduling policies are still pending.
5. App portability is partially implemented/planned: project clone should already carry app specs because they live in the project filesystem, and explicit CLI export/import/clone flows are being added; dedicated frontend download/upload UX is still pending.

### Not Done

1. Finalized static-mode smoke matrix (lite + launchpad, large-file/static cache cases).
2. Broader install coverage and post-install polish for `Install with Codex` across more templates/images.
3. Broader template catalog and stronger embed/open integration polish.

## 2. Product Goals

1. One model for all app types.
2. Safe-by-default (private and authenticated).
3. Agent-usable via deterministic CLI.
4. Works with low-traffic, high-state scientific workloads.
5. Compatible with existing JupyterLab/code-server/Pluto workflows.
6. Expand CoCalc value from "private compute project" to "project + deployable services."

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
3. Support direct app-spec clone between projects in the CLI so agents do not have to round-trip through local files.
4. Preserve only declarative app specs; do not clone runtime state, process state, logs, or public-exposure leases/tokens.
5. Make it clear that "clone project" is different from "clone app spec":
   - full project clone should already carry app specs automatically because the project filesystem clone includes `.local/share/cocalc/apps`,
   - runtime state and exposure metadata should still be re-created on first use in the destination environment.

Proposed portable bundle shape:

```json
{
  "version": 1,
  "kind": "cocalc-app-spec-bundle",
  "exported_at": "2026-03-07T00:00:00.000Z",
  "project_id": "source-project-id",
  "apps": [{ "...": "normalized app specs" }]
}
```

CLI/UI implications:

1. CLI:
   - `cocalc project app export <app-id>`
   - `cocalc project app export-all`
   - `cocalc project app import --file ...`
   - `cocalc project app clone <app-id> --from-project ... --to-project ...`
   - `cocalc project app clone-all --from-project ... --to-project ...`
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
   - runtime: native/X11 app inside the project,
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

1. Allow serving static paths from project via project-host.
2. Respect safe path constraints.
3. Optional aggressive caching headers for CDN cost control.
4. Public CoCalc-document viewer mode must run on a dedicated public origin/subdomain, not the same origin as authenticated CoCalc.
5. In public viewer mode, do not forward CoCalc cookies/tokens or expose authenticated project APIs.
6. Public viewer renderers must be read-only and work from file content alone, with no RTC/backend dependency.

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

### 10.6 Curated Template Catalog Plan

Template growth should not be hard coded only in frontend source. We want a curated catalog that CoCalc can ship centrally, while still allowing a site (or agent assisting a site admin) to override, extend, or fully replace that catalog.

Design goals:

1. Ship a default CoCalc-maintained template catalog from `https://software.cocalc.ai/...`.
2. Let sites configure one or more additional catalog sources in admin settings.
3. Merge catalogs with explicit priority rules so a site can:
   - add its own templates,
   - override selected CoCalc templates,
   - or suppress templates it does not want to surface.
4. Keep a small built-in fallback catalog in source so the Apps page still works if the remote catalog is unreachable.
5. Treat template metadata, install recipes, detection, and launch defaults as data rather than hard-coded React conditionals.

Recommended source model:

1. built-in fallback catalog bundled with the product:
   - minimal, stable core templates,
   - used when remote fetch fails or is disabled.
2. default remote CoCalc catalog:
   - hosted under `https://software.cocalc.ai/software/cocalc/apps/templates/...`,
   - contains richer template coverage, icons/images, install recipes, and example prompts.
3. site/admin catalogs:
   - configured as an ordered list of URLs or local paths,
   - merged after the default catalog with higher priority.
4. project-local catalogs:
   - stored inside the project filesystem,
   - intended for project-specific augmentation, experimentation, and agent-driven template development,
   - merged last with highest priority for that project only.

Recommended merge/priority rules:

1. Templates are keyed by stable `id`.
2. Later catalogs in the priority chain override earlier entries with the same `id`.
3. A catalog entry may explicitly mark a template hidden/disabled.
4. Sort order is an explicit numeric `priority`, not source-order alone.
5. The UI should show the final merged catalog only, not every source separately.
6. Project-local templates should be clearly labeled in the UI as project-scoped so users know they are not site/global defaults.

Recommended format:

Use versioned JSON, not ad hoc TypeScript literals.

Why JSON:

1. easy to host remotely,
2. easy to cache,
3. easy for agents/CLI/admin tooling to inspect,
4. easy to validate with JSON schema,
5. avoids executable source as catalog data.

Recommended project-local location:

1. `.local/share/cocalc/app-templates/*.json`
2. or, if we later want a broader shared catalog namespace:
   - `.local/share/cocalc/catalog/app-templates/*.json`

The important requirement is that project-local template catalogs live alongside project data and clone naturally with the project, similar to app specs themselves.

Suggested catalog shape:

```json
{
  "version": 1,
  "kind": "cocalc-app-template-catalog",
  "source": "cocalc-default",
  "published_at": "2026-03-09T00:00:00.000Z",
  "templates": [
    {
      "id": "jupyterlab",
      "title": "JupyterLab",
      "category": "core",
      "priority": 100,
      "icon": "https://software.cocalc.ai/software/cocalc/apps/icons/jupyterlab.png",
      "homepage": "https://jupyter.org/",
      "description": "Interactive notebooks, terminals, and files.",
      "supported_kinds": ["service"],
      "detect": {
        "commands": ["jupyter lab --version", "jupyter-lab --version"]
      },
      "install": {
        "strategy": "curated",
        "recipes": [
          {
            "id": "ubuntu-apt-plus-pip",
            "match": { "os_family": ["debian", "ubuntu"] },
            "commands": [
              "apt-get update",
              "apt-get install -y jupyter jupyter-notebook jupyter-server python3-jupyterlab-server python3-ipykernel python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed jupyterlab"
            ],
            "notes": "Preferred on maintained Ubuntu launchpad images because Ubuntu 24.04 does not ship a top-level jupyterlab apt package."
          }
        ]
      },
      "launch": {
        "preset_id": "jupyterlab"
      },
      "verify": {
        "commands": ["jupyter lab --version", "python3 -m jupyterlab --version"]
      },
      "agent_prompt_seed": "On the usual Ubuntu launchpad image, skip apt package discovery for jupyterlab itself and use the tested apt-plus-pip recipe directly unless the runtime is already installed."
    }
  ]
}
```

Template entry responsibilities:

1. product metadata:
   - title,
   - description,
   - category,
   - image/icon,
   - docs/homepage link.
2. detection metadata:
   - how to decide `installed`, `missing`, or `unknown`.
3. installation metadata:
   - one or more curated recipes,
   - environment matching hints,
   - human notes.
4. launch metadata:
   - the app preset/spec fragment or preset id to instantiate.
5. verification metadata:
   - post-install checks we know should pass.
6. agent prompt seed:
   - a short template-specific hint for `Install with Codex`.

Install strategy plan:

1. Start with curated recipes for the top 20-30 templates.
2. Prefer system-level install methods where sensible on launchpad:
   - `apt-get` first on maintained Ubuntu images,
   - language-native install only when that is the better real-world route.
3. Explicitly mark unsupported install methods in prompts and metadata:
   - no `snap` in launchpad/podman environments.
4. Before agent-driven install:
   - if the UI/user opted into a snapshot, create it before opening Codex,
   - include the created snapshot name in the prompt/result rather than asking Codex to improvise snapshot handling.
5. After install:
   - run the template verify commands,
   - then offer to instantiate the app spec.

Admin configuration implications:

1. admin settings should allow:
   - enable/disable remote catalog fetch,
   - configure an ordered list of catalog URLs/paths,
   - optionally pin to a curated CoCalc catalog version.
2. sites should be able to ship private/internal templates without forking frontend code.
3. the merged catalog result should be cached locally with refresh/invalidation controls.
4. admins should be able to enable/disable project-local catalogs if they want stricter control.

Agent/admin extension workflow:

Agents should understand that the template catalog is an operator-controlled artifact, not just fixed product data.

Expected workflow:

1. inspect the current merged catalog sources and priority order,
2. determine whether the request should:
   - extend the site catalog,
   - override a CoCalc default template,
   - or propose a core-catalog improvement upstream,
3. add or modify the template entry in the highest-priority appropriate catalog,
4. validate:
   - install recipe,
   - verify commands,
   - app start,
   - app open,
5. publish/update the catalog,
6. refresh catalog cache on the site,
7. report back the exact template id, source, recipe used, and validation result.

Common development path:

1. prototype a new template first in the project-local catalog,
2. test it in that project,
3. if successful, promote it to a site/admin catalog or upstream CoCalc catalog later.

Agent guidance implications:

1. agents should prefer site-local catalog extension over patching core frontend code when the request is admin/site-specific,
2. agents should know the catalog format and where the configured sources live,
3. agents should treat template additions as data-first changes with validation, not ad hoc UI edits,
4. a future dedicated skill should cover:
   - launchpad installation assumptions,
   - snapshot-before-install policy,
   - catalog editing and publication,
   - verification steps.

Frontend implications:

1. the Apps page template picker should render from the merged catalog, not a hard-coded array.
2. each template card should support:
   - image/icon,
   - short description,
   - docs link,
   - install state,
   - `Create`,
   - `Install with Codex`.
3. templates with known curated recipes should say so.
4. templates with unknown installability should still be available via agent flow, but labeled accordingly.

Validation plan:

1. maintain a tested top-template matrix in the repo,
2. periodically run install + start + open verification against the curated recipes,
3. feed the working commands/examples back into the catalog and agent prompts.

Broader catalog platform note:

This catalog machinery should later generalize into a broader software catalog system, especially for Jupyter kernels.

Principle:

1. do not force apps and kernels into one identical schema immediately,
2. do reuse the same catalog infrastructure:
   - remote/local sources,
   - merge rules,
   - priority,
   - detection,
   - install recipes,
   - verification,
   - agent/admin extension workflow.

Likely later catalog kinds:

1. `app-template`
2. `kernel-template`

Kernel-specific metadata would differ, but the operator/agent/product problems are similar enough that the app-template work should be designed as the first instance of a broader catalog platform, not a dead-end one-off.

Non-goals for the first slice:

1. arbitrary user-authored template catalogs with executable code,
2. full package-manager abstraction for every Linux distro,
3. freeform unaudited remote templates that immediately execute without review.
4. project-local catalogs that contain executable logic instead of pure versioned data.

## 11. CLI Plan (Agent-First)

Introduce `cocalc project app` command group with JSON-first output.

Core commands:

1. `cocalc project app list --json`
2. `cocalc project app get <app-id> --json`
3. `cocalc project app upsert --file spec.yaml --json`
4. `cocalc project app delete <app-id> --json`
5. `cocalc project app start <app-id> --wait --json`
6. `cocalc project app stop <app-id> --json`
7. `cocalc project app restart <app-id> --wait --json`
8. `cocalc project app logs <app-id> --tail 200`
9. `cocalc project app expose <app-id> --public --ttl 24h --json`
10. `cocalc project app unexpose <app-id> --json`
11. `cocalc project app ensure-running <app-id> --json`
12. `cocalc project app detect --json`
13. `cocalc project app audit <app-id> --public-readiness --json`
14. `cocalc project app export <app-id> --json`
15. `cocalc project app export-all --json`
16. `cocalc project app import --file app.json --json`
17. `cocalc project app clone <app-id> --from-project <src> --to-project <dst> --json`

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
4. a full web browser such as chromium -- it can be useful having it run directly inside the project

Conceptually, this is a second app-launch mode:

1. managed web app:
   - start service in project,
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

1. project identity,
2. remote target details,
3. local port or local application being launched,
4. expected duration/persistence,
5. whether the action is one-shot or remembered for the current session/project.

Security model:

1. daemon requests must be narrowly typed capabilities, not arbitrary shell commands,
2. examples:
   - "forward remote port 8787 to local 127.0.0.1:8877",
   - "launch `xclock` over approved SSH/X11 session",
3. every action should be attributable to a signed-in user and a specific project,
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

1. `cocalc project app ssh-forward <app-id> --local-port 8888 [--remote-port auto] --json`
   - ensures project runtime is reachable for SSH,
   - resolves app target port (or accepts explicit),
   - outputs ready-to-run local command and connection metadata.
2. `cocalc project app ssh-forward-command <app-id> --local-port 8888`
   - prints a single copy/paste command for local laptop execution.
3. `cocalc project app ssh-forward stop <session-id>`
   - optional if we manage background local helpers from CLI wrappers.
4. `cocalc project app launch-native <app-id> --json`
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

### 13.3.3 Concrete Implementation Plan

The right implementation strategy is CLI-first, using existing SSH plumbing and
reusing a narrow subset of [`reflect-sync`](/home/wstein/build/reflect-sync)
instead of inventing a fresh tunnel manager.

There is already precedent in
[`src/packages/plus`](/home/wstein/build/cocalc-lite/src/packages/plus),
where CoCalc Plus exposes a small opinionated port-forward/sync UI on top of
`reflect-sync` rather than surfacing its full raw option set.  We should do the
same here.

#### Phase 1: CLI `forward-command`

Goal:

1. generate a correct copy/paste SSH forward command for a managed app,
2. prove the end-to-end path without yet depending on a local daemon.

Scope:

1. service apps only,
2. no native/X11 launch yet,
3. no automatic local background process management yet.

Command shape:

1. `cocalc project app forward-command <app-id> [--local-port 0]`
2. `cocalc project app forward-command --project <id> <app-id>`

Behavior:

1. fetch app spec/status,
2. ensure the app is running,
3. resolve the actual target port,
4. choose or print the local port,
5. output a single command that forwards:
   - local `127.0.0.1:<local-port>`
   - to remote `127.0.0.1:<app-port>`
   - through the existing CoCalc SSH path.

Notes:

1. any managed service app with a concrete port should be forwardable,
2. this does not require changes to app specs,
3. this is especially valuable for apps that fail under `proxy` and `port`.

#### Phase 2: CLI `forward`

Goal:

1. let `cocalc-cli` actually establish and maintain the local tunnel,
2. keep the feature testable without any frontend work.

Command shape:

1. `cocalc project app forward <app-id> [--local-port 0]`
2. `cocalc project app forward status`
3. `cocalc project app forward stop <session-id|app-id>`

Behavior:

1. wrap a constrained `reflect-sync`-backed port forward,
2. reuse existing SSH key/bootstrap logic,
3. emit the local URL and session metadata,
4. optionally keep the forward alive in the local CLI daemon.

Important product constraint:

1. do **not** expose the full `reflect-sync` CLI/API surface,
2. do expose a curated app-oriented forward experience with conservative defaults.

#### Phase 3: Apps Page Integration

Goal:

1. make SSH forwarding visible and usable from the Apps page,
2. avoid forcing users to learn CLI syntax before the feature is useful.

UI:

1. add `Tunnel locally` to app actions,
2. show a modal with:
   - local URL,
   - copyable CLI command,
   - short explanation of when this is preferable to proxy/public URLs,
   - trust note that the tunnel is private and user-scoped.

Initial behavior:

1. the modal may simply call `forward-command`,
2. no daemon automation is required for the first pass.

#### Phase 3.1: CLI Onboarding / Auth Login

Goal:

1. make local app forwarding usable by ordinary users, not just developers who
   already have a configured `cocalc` CLI,
2. keep the Apps-page `Tunnel locally` flow simple while the deeper automation
   catches up.

Near-term Apps UI behavior:

1. `Tunnel locally` opens a modal,
2. the modal links to the CLI download page:
   - `https://software.cocalc.ai/software/cocalc/index.html`
3. the modal shows a copyable command such as:
   - `cocalc project app forward --project <id> <app-id>`
4. no browser-to-daemon automation is required yet.

CLI onboarding gap:

1. the current `cocalc auth login` command is still a profile/credential storage
   command, not a polished end-user login flow,
2. users should not be expected to manually reason about API URLs, bearer
   tokens, or profile internals before using app forwarding.

Planned `cocalc auth login` product shape:

1. prompt for the CoCalc site when not already known, e.g.:
   - `https://dev.cocalc.ai`
2. start a standard browser/device-style auth flow,
3. persist an auth profile automatically,
4. return to the original command once login succeeds,
5. make the first-run path for:
   - `cocalc project app forward ...`
   - future daemon-assisted local forwarding
   feel normal and self-explanatory.

Non-goals for this slice:

1. solving local daemon approval UX,
2. implementing the full long-term browser/daemon pairing story,
3. exposing the raw auth/profile surface in the Apps UI.

#### Phase 4: Daemon-Assisted Forwarding

Goal:

1. remove copy/paste friction,
2. let the local daemon own the tunnel lifecycle.

Behavior:

1. Apps UI sends a typed request to the local daemon,
2. daemon prompts for approval,
3. daemon starts/stops the port forward,
4. UI shows connected/disconnected state and local URL.

Security constraints:

1. typed capability request only,
2. no arbitrary remote-to-local shell execution,
3. approval remembered only within a limited project/session scope.

#### Phase 5: Native/X11 Launch

Goal:

1. extend the same transport story to native GUI apps,
2. keep Linux-first scope.

Command shape:

1. `cocalc project app launch-native <app-id>`
2. later optionally `cocalc project app launch-native --daemon`

Behavior:

1. app spec declares a native launch command,
2. CLI returns or performs an SSH/X11 bootstrap,
3. same daemon approval model can be reused later.

#### Testing Plan

Phase 1 and 2:

1. smoke test with a managed HTTP app that is known to proxy poorly,
2. verify that the generated tunnel reaches the raw app successfully,
3. verify wake-on-demand still works before the SSH session is established.

Phase 3 and 4:

1. browser test that the Apps page shows the correct command and local URL,
2. daemon test that approval/deny paths behave correctly,
3. ensure failed local tunnel setup produces actionable errors.

Phase 5:

1. Linux smoke test with `xclock`,
2. then test a heavier native app such as `chromium` or `gimp`,
3. explicitly document macOS/Windows as later or best-effort.

#### Explicit Non-Goals for First Pass

1. exposing every `reflect-sync` option,
2. full general-purpose bidirectional sync UX in the Apps page,
3. native app support on all desktop OS's immediately,
4. background local automation without user approval.

## 14. Static Site Mode

Support static hosting for large dataset-backed websites.

Requirements:

1. serve directory tree from app spec,
2. optional index fallback,
3. efficient range requests for large files,
4. cache-control configuration,
5. optional public mode with CDN edge caching.
6. support "static-only app" without process launch (directory served directly by project-host).

## 14.1 Proposed CoCalc Public Viewer Mode

This is a second static-serving mode aimed at CoCalc-native documents rather than generic HTML trees.

Core idea:

1. serve live files directly from a project path with no copy-to-bucket/publish step,
2. ship a prebuilt public CoCalc viewer bundle to the browser,
3. let the browser render supported CoCalc file types read-only from the raw file contents.

This is complementary to globally cached publishing/share-server workflows:

1. public viewer mode optimizes for immediacy and self-hosting,
2. cached/share workflows optimize for durable public distribution and heavier edge caching.

Important implementation constraint:

1. the renderer path must be able to work without authenticated CoCalc API access or RTC,
2. that is realistic because TimeTravel already renders static historical versions client-side, and the current share server already proves this for several document types,
3. slides and whiteboards should be among the easier early targets because there is already precedent for read-only rendering.

Requirements:

1. serve live project files directly from disk so a newly saved file is immediately visible at the public URL,
2. use a dedicated public origin/subdomain with no shared authenticated browser state,
3. provide a prebuilt public viewer bundle that contains only the read-only rendering path needed for supported document types,
4. never expose authenticated project APIs, collaboration state, or CoCalc credentials to the public viewer,
5. keep rendering strictly read-only; no editing, no RTC, no authenticated actions,
6. support the first useful set of file types:
   - `.md`
   - `.ipynb`
   - `.slides`
   - `.board`
   - later `.chat` if the read-only renderer path is clean enough
7. allow optional lightweight freshness features later:
   - polling,
   - `ETag` / `Last-Modified`,
   - or explicit browser auto-refresh
8. continue to allow normal CDN caching/Cloudflare caching in front of the public origin.

Security boundary:

1. separate origin/subdomain from the authenticated CoCalc app is mandatory,
2. strip/ignore CoCalc cookies and auth tokens entirely,
3. use a strict CSP and safe static response headers,
4. treat file contents as untrusted input and keep document sanitization strong,
5. prefer a narrower public-viewer bundle over the full authenticated CoCalc app when possible.

Possible app-spec shape:

```yaml
kind: static
id: public-course-notes
title: Public Course Notes
static:
  root: /home/user/project/public
  index: index.html
  cache_control: public,max-age=300
integration:
  mode: cocalc-public-viewer
  file_types: [".md", ".ipynb", ".slides", ".board"]
  viewer_bundle: /opt/cocalc/share/public-viewer/index.html
  auto_refresh_s: 0
```

Suggested MVP:

1. begin with `.md`, `.ipynb`, `.slides`, and `.board`,
2. make the route/file lookup rules simple and explicit,
3. do not attempt live collaboration,
4. add optional polling-based freshness only after the basic read-only viewer is solid,
5. document clearly that this is immediate live-public viewing, not the same thing as durable exported publishing.

## 14.2 Activity-Driven Static Refresh Jobs

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

## 14.3 Cost and Policy Guardrails

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
4. expand and polish the existing `Install with Codex` / `Audit with Codex` UI handoff actions

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
3. `cocalc project app ...` commands fully cover lifecycle in JSON mode.
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
17. `[partial]` Add "Install with Codex" from app presets and app rows (implemented with template-aware prompts and explicit thread titles; broader template coverage, snapshot polish, and post-install automation are still pending).
18. `[todo]` Add SSH port-forward fallback in CLI + UI for non-proxy-compatible apps.
19. `[todo]` Audit managed-app XSS exposure specifically for CoCalc credentials/session material (cookie stripping, project-host session scope, private same-origin app behavior, static HTML assumptions).
20. `[partial]` Add app portability workflows:

   - explicit CLI export/import/clone,
   - document that full project clone already carries app specs because they live in the project filesystem,
   - frontend download/upload/"copy to another project" UX still pending.

21. `[todo]` Add scoped per-app metrics in project-host and surface them in CLI/UI.

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
   - done: strip project-host bootstrap bearer auth header after validation so it is not proxied upstream,
   - done: strip project-host auth/session cookies before forwarding traffic upstream to the managed app,
   - done: scope the project-host session cookie as narrowly as possible instead of using a broad path,
   - done: validate live that the project-host session cookie is scoped to `/${project_id}` and that a private app in project A cannot fetch a private app in project B on the same host,
   - done: add regression coverage for project-host session-cookie scope and project-host `/customize` payload trimming,
   - done: trim project-host `/customize` so it no longer exposes `account_id`,
   - done: explicitly choose the same-project trust model for private apps and document it in `docs/security/private-app-trust-model.md`,
   - next: harden static HTML serving assumptions accordingly.
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
7. scoped per-app metrics and simple usage/history UI.

## 19.3 MVP Metrics Plan

The goal is not full observability. The goal is enough app-level traffic and
runtime visibility for users and operators to understand whether an app is
being used, whether it is consuming bandwidth, and whether wake/public traffic
behavior matches expectations.

### Scope

Implement metrics only at the managed-app proxy layer, primarily in
project-host. Do not attempt to introspect application internals.

### Collection Point

Collect metrics in the project-host proxy path, since that now sees:

- private managed app traffic,
- direct public app traffic,
- websocket upgrades,
- wake-on-demand traffic transitions.

This avoids per-app instrumentation and measures the actual traffic shape that
matters for operator cost and user experience.

### First Metrics to Capture

Per `(project_id, app_id)` and split by `private` vs `public` mode:

- request count,
- response status buckets (`2xx`, `3xx`, `4xx`, `5xx`),
- bytes sent,
- bytes received,
- latency aggregates (`count`, `sum`, rough `p50` / `p95` friendly buckets),
- websocket upgrade count,
- active websocket count,
- last hit timestamp,
- wake-on-demand count.

### Storage Model

- keep hot counters in memory on project-host,
- flush aggregated rows to project-host sqlite periodically,
- store rollups at a coarse interval (e.g. minute buckets plus rolling totals),
- avoid one-row-per-request storage.

This should be enough for trend views, operator summaries, and cost warnings
without turning sqlite into a request log.

### Privacy / Safety Constraints

Do **not** store by default:

- full URLs or query strings,
- request/response bodies,
- arbitrary headers,
- high-cardinality per-path metrics.

The MVP should be aggregate-only. App-level deep introspection is the user's
responsibility inside the project itself.

### CLI Surface

Add something like:

- `cocalc project app metrics <app-id>`
- `cocalc project app metrics --all`
- `cocalc project app metrics <app-id> --window 24h`

Return stable JSON suitable for agents and admin tooling.

### UI Surface

On the Apps page, show compact usage facts for each app or in row details:

- last hit,
- requests in recent window,
- egress in recent window,
- active websocket count,
- wake count.

Also add a very small history plot using the same direct-SVG style already used
elsewhere in CoCalc frontend for process history. Nothing fancy is needed; a
simple sparkline/bar history for requests or bytes over time is enough.

### Admin / Cost Use

Use the same metrics stream for:

- metered-egress warnings on hosts like GCP,
- identifying unexpectedly hot public apps,
- helping explain wake/sleep behavior,
- future throttling or membership policy decisions.

### Explicit Non-Goals for MVP

- Prometheus-scale observability,
- tracing across hub/project-host/app layers,
- per-route analytics,
- request log search,
- app-internal profiling.

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
