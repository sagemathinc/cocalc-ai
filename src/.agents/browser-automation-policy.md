# Browser Automation Policy Layer

This document defines the security model for `cocalc browser ...` automation, with emphasis on safe production behavior.

## Problem

Raw browser JavaScript execution (`browser exec`) is extremely powerful. Without policy enforcement, an agent can click/type/submit destructive actions (billing, account deletion, host deletion, etc.).

We need:

- fast local developer workflows (`dev` posture),
- safe-by-default production workflows (`prod` posture),
- explicit, auditable elevation for risky actions.

## Posture Model

Two postures are supported:

1. `dev`
   - optimized for local debugging.
   - raw JS exec allowed.
   - minimal friction.

2. `prod`
   - deny-by-default for raw JS exec.
   - only explicitly allowed actions/policies may run.
   - intended for cloud/real user data contexts.

Default posture selection:

- loopback/localhost API target: `dev`
- non-loopback API target: `prod`

The CLI can override via `--posture dev|prod` (or env var `COCALC_BROWSER_POSTURE`).

## Current Baseline (implemented)

`browser exec` now accepts:

- `posture`
- `policy`

In `prod` posture:

- raw JS exec is blocked unless policy explicitly sets `allow_raw_exec: true`.
- optional project and origin scoping are enforced.

Policy schema (`version: 1`):

```json
{
  "version": 1,
  "allow_raw_exec": true,
  "allowed_project_ids": ["<workspace-uuid>"],
  "allowed_origins": ["https://example.cocalc.com"]
}
```

Notes:

- This is intentionally strict as a bootstrap.
- It provides immediate protection against accidental unrestricted prod automation.

## Why this is still not enough

Even with `allow_raw_exec`, JS is still Turing-complete and hard to reason about for risk.

Long-term safe model requires:

1. typed action API (`click`, `type`, `press`, `waitForSelector`, etc.),
2. server-side policy checks for each action verb,
3. privileged approval tokens for sensitive action classes,
4. immutable audit trail of allow/deny decisions.

## WASM JavaScript Interpreter Direction

Running user/agent scripts in a constrained WASM JS interpreter is a strong direction for production hardening:

- can remove ambient access to browser globals,
- can expose only curated host functions,
- can enforce deterministic limits (cpu/steps/time/memory),
- can reduce accidental abuse surface.

However, this should complement (not replace) action-level policy:

- policy must still gate the host functions exposed to WASM,
- privileged actions still need explicit approval and audit.

## Next Implementation Phases

### Phase A: Baseline policy complete

- posture + policy parsing in CLI
- posture + policy enforcement in browser-session service
- prod blocks raw exec by default

### Phase B: Typed actions

- add `browser action click/type/press/wait-for-selector/wait-for-url`
- classify actions (`read`, `input`, `navigate`, `privileged`)
- enforce policy per action instead of raw script

### Phase C: Approval + audit

- short-lived approval tokens for privileged actions
- policy decisions logged with actor/session/url/selector/action/decision
- retrieval commands for incident review

### Phase D: Optional WASM sandbox

- run scripts in constrained runtime with explicit host capability bridge
- disable unrestricted JS `new Function` path in prod by default

## CLI Surface (target)

Near-term:

- `cocalc browser exec --posture ... --policy-file ...`

Next:

- `cocalc browser action click ...`
- `cocalc browser action type ...`
- `cocalc browser action wait-for-selector ...`

Future:

- `cocalc browser approval issue ...`
- `cocalc browser policy validate ...`
- `cocalc browser audit list ...`

## Non-goals

- Building complete policy UX before baseline enforcement exists.
- Pretending prod safety exists while unrestricted raw JS remains default.

