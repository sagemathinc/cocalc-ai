# CoCalc-AI Alpha Release Plan

## Purpose
This document defines the execution plan for the first alpha release of CoCalc-AI using items currently tagged `#alpha` in `/home/wstein/cocalc.com/work/wstein.tasks.md`.

Goals:
- keep scope tight enough to ship,
- make dependencies explicit,
- define what "done" means for each item,
- avoid hidden blockers between phases.

## Release Scope
- **In scope:** tasks tagged `#alpha0`, `#alpha1`, `#alpha2`.
- **Out of scope for first alpha:** everything else unless it blocks an in-scope item.

## Definition of Done (Global)
A phase is complete only if:
1. Each task has a reproducible manual test that passes.
2. The relevant smoke path passes end-to-end in both lite and launchpad where applicable.
3. Regressions are captured by at least one automated test where practical.
4. No known `#blocker` remains in that phase.

---

## Phase Alpha0 (Boot and Lifecycle Correctness)
These are hard prerequisites for reliable tester onboarding.

### A0.1 Launchpad host/project status gating in frontend
**Task:** "frontend UI for working with projects need to be much more aware of host status"

**Done when:**
- Start actions are disabled when host is not `running+online`.
- Project status cannot display `running` if host is not `running+online`.
- Attempting start while host is offline gives a clear action path (e.g., move/start host).

**Depends on:** backend host status truth being accurate and timely.

---

### A0.2 New project start fails: rootfs not mounted
**Task:** "starting any new project says rootfs is not mounted"

**Done when:**
- Fresh project creation + first open never hits `rootfs is not mounted`.
- If mount does fail, user gets a deterministic recovery path and non-silent error.

**Depends on:** provisioning/mount sequencing in project-host lifecycle.

---

### A0.3 New project assigned/started before host ready
**Task:** "creating new project VERY slow; do not assign/start until host is ready"

**Done when:**
- No assignment/start attempt occurs before host has confirmed ready state.
- Explorer no longer shows early "no subscribers matching fs.project-..." race errors.

**Depends on:** host readiness signal contract and queueing logic.

---

### A0.4 First terminal on new project hangs
**Task:** "terminal on new project hangs immediately"

**Done when:**
- First terminal on a newly created project opens reliably without restart.
- No transient "Restarting" spinner regression caused by duplicate start attempts.

**Depends on:** A0.2 + A0.3 (mount/readiness races).

---

### A0.5 Lite codex shows false “unconfigured”
**Task:** "in lite mode chat with codex says unconfigured"

**Done when:**
- Lite always reflects actual local codex config state.
- No spurious `unconfigured` badge when codex is available.

**Depends on:** none of A0.1-A0.4 (can run in parallel).

---

## Phase Alpha1 (Auth, Security, and Host Operations)
These items lock down secure multi-user cloud behavior.

### A1.1 Port impersonate user/auth token to launchpad (+ CLI)
**Task:** "port impersonate user/auth token to launchpad (not Next.js)"

**Done when:**
- Launchpad can mint/validate user-scoped auth tokens without Next.js dependency.
- CoCalc CLI path supports the same token flow.

**Depends on:** stable host/project identity model from Alpha0.

---

### A1.2 Project-host selection only allows definitely running hosts
**Task:** "project-host selection for workspace - only allow working definitely running hosts"

**Done when:**
- Selector filters invalid/offline/unknown hosts.
- Selection behavior matches runtime start constraints from A0.1.

**Depends on:** A0.1 host status semantics.

---

### A1.3 Host stop should not fail on missing project volume
**Task:** "stopping a project host shouldn't fail because some project volume doesn't exist"

**Done when:**
- Stop flow tolerates "project volume missing" as non-fatal for stop.
- Fatal errors are limited to truly safety-critical cases.

**Depends on:** none; can be implemented in parallel with A1.1.

---

### A1.4 Extensible secure project proxies
**Task:** "make project proxies easily extensible ... token must be in URL"

**Done when:**
- Proxy routes are declarative/extensible.
- Token validation is centralized and enforced for all proxy entries.
- Starting secure web services does not require ad hoc route hacks.

**Depends on:** A1.1 token plumbing.

---

### A1.5 Launchpad startup port conflict handling
**Task:** "refuse to run with clear error if ports in use or auto-find port"

**Done when:**
- Launchpad refuses startup with actionable error if fixed ports conflict.
- If `PORT` is unset, it chooses an available port deterministically.

**Depends on:** none.

---

## Phase Alpha2 (Editor/UX Stability and Agent Capability)
These are high-visibility issues for tester confidence.

### A2.1 Plus/Lite drag-and-drop upload broken on remote machines
**Task:** "plus/lite drag-n-drop upload doesn't work"

**Done when:**
- Drag-drop upload works on remote-hosted plus/lite sessions.
- At least one automated test covers regression risk.

**Depends on:** none.

---

### A2.2 Slate image resize crash
**Task:** "resizing image in markdown block mode crashes (`saveValue` error)"

**Done when:**
- Resize no longer throws.
- Resize persists correctly and can be undone/redone.

**Depends on:** none.

---

### A2.3 Slate quote backspace data-loss bug
**Task:** "backspace in quote deletes prior content"

**Done when:**
- Backspace behavior matches expected quote merge semantics.
- Regression tests cover both reported reproduction cases.

**Depends on:** none.

---

### A2.4 Agent/codex turns include CLI info + skill for browser use
**Task:** "codex turns have agent CLI information and skill"

**Done when:**
- Default codex session in home page includes required agent context.
- Flyout exposes an Agents tab and removes obsolete non-agent path.

**Depends on:** can run independently; validate against A1 auth model for cloud mode.

---

### A2.5 Jupyter with no default kernel shows blank notebook
**Task:** "if no default kernel, notebook is blank"

**Done when:**
- Notebook auto-prompts kernel selection (or equivalent flow) instead of blank view.
- User can recover without reload/workaround.

**Depends on:** none.

---

## Dependency Audit (Critical Path)

### Hard critical path
1. **A0.2 + A0.3** (mount/readiness correctness)
2. **A0.4** (terminal first-open hang)
3. **A0.1** (frontend lifecycle gating)
4. **A1.1** (token/auth flow into launchpad+CLI)
5. **A1.4** (secure proxy extensibility)

Without these, alpha testers will hit immediate operational failures in cloud workflows.

### Medium dependencies
- **A1.2** depends on status semantics from **A0.1**.
- **A2.4** should validate against **A1.1** in cloud contexts.

### Parallelizable workstreams
- Stream S1 (Launchpad lifecycle): A0.1, A0.2, A0.3, A0.4
- Stream S2 (Auth/proxy): A1.1, A1.4
- Stream S3 (Host operations): A1.3, A1.5, A1.2
- Stream S4 (Editor/Jupyter/lite UX): A0.5, A2.1, A2.2, A2.3, A2.5, A2.4

---

## Suggested Execution Order
1. Finish **Alpha0** fully before broad external testing.
2. Start **A1.1** in parallel with late Alpha0 since it is a long-pole item.
3. Complete remaining **Alpha1**.
4. Use **Alpha2** as stabilization before widening tester cohort.

---

## Exit Criteria for First External Alpha
Ship to external alpha testers only when:
- Alpha0 complete,
- A1.1 + A1.4 complete,
- no known data-loss bugs remain in editor path (A2.2/A2.3),
- upload and notebook baseline usability are functional (A2.1/A2.5).
