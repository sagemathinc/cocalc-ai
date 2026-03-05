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

### Partial

1. Static app mode backend exists and dedicated launchpad static-heavy smoke scenario (`apps-static`) is implemented; broader matrix (lite parity + larger cache/static variants) is still pending.
2. Cost guardrails are currently warning/policy-hint driven; deeper throttling/limits tuning remains.
3. Pre-expose Codex audit exists at backend/CLI level; UI button flow is not yet implemented.

### Not Done

1. Dedicated app UI workflows and polish (`+New` app wizard, app management panel polish, autodetection UX, embed polish).
2. Finalized static-mode smoke matrix (lite + launchpad, large-file/static cache cases).

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

1. Provide explicit `app export/import` CLI for migration and backup.

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

## 10. UI Plan

### 10.1 Create Flow

Add `App Server` in `+New`:

1. choose app template or custom,
2. set command/port/base path/iframe/public mode,
3. save spec and optionally start now.

Alpha priority note:

1. Keep initial UI minimal and thin over CLI/API.
2. Main investment goes to backend lifecycle + CLI + agent integration first.

### 10.2 App Management

Project app panel with:

1. status (running/starting/stopped/error),
2. private URL and optional public URL,
3. quick actions (start/stop/restart/expose/revoke/logs/edit),
4. last error snippet and health status.

### 10.3 Port Autodetection

Detect new local HTTP listeners and prompt:

1. "We detected service on :XXXX. Create app proxy?"
2. one-click creates spec from discovered port.

### 10.4 Embedding

1. `iframe=auto` tries embedded view first.
2. if blocked by headers/policies, auto-fallback to external tab.
3. "Open in full tab" button always present.

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

## 14. Static Site Mode

Support static hosting for large dataset-backed websites.

Requirements:

1. serve directory tree from app spec,
2. optional index fallback,
3. efficient range requests for large files,
4. cache-control configuration,
5. optional public mode with CDN edge caching.
6. support "static-only app" without process launch (directory served directly by project-host).

## 14.1 Cost and Policy Guardrails

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

### Phase 3: UI Expansion (after backend confidence) (Status: not started)

1. `+New` app server wizard polish
2. app management panel polish
3. autodetection suggestions UX
4. iframe auto-fallback polish

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
9. `[partial]` Add Codex app audit prompt/action path for public expose (backend+CLI done; UI action pending).
10. `[partial]` Add end-to-end tests in lite and launchpad for service and static cases (service launchpad smoke done; static smoke pending).
10. `[partial]` Add end-to-end tests in lite and launchpad for service and static cases (service launchpad smoke done; launchpad `apps-static` smoke added; lite parity + broader static matrix pending).
11. `[todo]` Build minimal UI wrapper (`+New` + manage panel) over stable backend/CLI.

## 19.1 Next Execution Order

1. Run and harden launchpad `apps-static` smoke in live cloud loop, then add lite static parity and broader static matrix.
2. Add minimal UI wrappers after static smoke is green.
3. Add pre-expose "Audit with Codex" UI action, likely using the same style/pattern as the new in-progress agentized Help-me-fix flow.

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
