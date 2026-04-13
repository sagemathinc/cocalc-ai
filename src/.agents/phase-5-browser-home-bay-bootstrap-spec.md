# Phase 5 Browser Home-Bay Bootstrap Spec

Status: proposed implementation spec as of 2026-04-13.

This document freezes the intended browser-facing account-home-bay model for
Phase 5. It covers:

- public and per-bay DNS naming
- browser bootstrap after public entry
- wrong-bay sign-in recovery
- signup home-bay selection
- cookie and origin expectations
- seed-bay-managed DNS setup

This is a concrete implementation note, not a broad architecture overview.

## Goals

The browser model must satisfy all of the following:

- the user enters one stable public site URL
- the browser control plane is homed on exactly one account bay
- direct project-host runtime connections remain separate
- no inter-bay server-side proxying is used for interactive browser traffic
- bay selection during signup is automatic
- adding a new bay requires minimal setup beyond pointing it at the seed bay

## Primary Decisions

### Stable Public URL

The stable public site URL is derived from the configured site DNS.

Examples:

- `lite4b.cocalc.ai`
- `launchpad.example.com`

This is the URL users type, bookmark, and share.

### Per-Bay Public Hostnames

Each bay gets its own public hostname derived from the same configured DNS.

Examples for `lite4b.cocalc.ai`:

- `bay-0-lite4b.cocalc.ai`
- `bay-1-lite4b.cocalc.ai`
- `bay-2-lite4b.cocalc.ai`

The bay hostname uses the stable short bay id, not a UUID.

Rationale:

- easier operations and debugging
- no security value from UUID hostnames
- consistent with project-host naming

### Browser URL Stability

The visible browser location remains on the stable public site URL whenever
possible.

The browser may connect its control-plane websocket and API traffic to the
account-home bay hostname behind the scenes, but the visible page URL should
remain stable.

### No Server-Side Proxying For Browser Inter-Bay Control Traffic

If the user is on the wrong bay for sign-in or bootstrap, the recovery must be
structured and explicit. We do not proxy interactive browser control traffic
through a different bay server-side.

Reasons:

- lower latency
- lower bay load
- fewer hidden failure modes
- simpler scaling model
- consistent with direct project-host connections

### Seed Bay Manages Bay DNS

The seed bay is responsible for creating and updating public DNS records for
bays, similar to how host DNS is already managed.

The seed bay holds the Cloudflare credentials and performs DNS setup on behalf
of the cluster.

Adding a new bay should require:

- provisioning the bay
- pointing it at the seed bay / cluster fabric
- no separate manual Cloudflare credential plumbing on that bay

## Naming Rules

Assume the configured site DNS is `SITE_DNS`.

Then:

- public site URL: `https://SITE_DNS`
- bay hostname for bay id `bay-N`: `https://bay-N-SITE_DNS`
- host hostname remains its existing derived form

Examples:

- `https://lite4b.cocalc.ai`
- `https://bay-0-lite4b.cocalc.ai`
- `https://bay-1-lite4b.cocalc.ai`

The bay hostname derivation must be a pure function of:

- configured site DNS
- stable bay id

No separate per-bay manual hostname config should be required in the common
case.

## Browser Control-Plane Model

The browser has exactly one control-plane bay at a time.

That bay is the user's account home bay.

The browser may also open:

- direct project-host runtime connections
- direct project-host project-scoped Conat connections

Those runtime connections are separate from the account-home control-plane
connection and do not change the account-home bay model.

## Bootstrap Flow

### Initial Visit

1. User visits `https://SITE_DNS`.
2. Public page and auth UI load from the stable site URL.
3. No bay-specific assumption is made yet beyond reaching a public entry bay.

### After Successful Sign-In

1. The sign-in request resolves the account's `home_bay_id`.
2. If the current bay is the home bay:
   - sign-in completes normally
   - browser receives auth cookies and control-plane bootstrap metadata
3. If the current bay is not the home bay:
   - the current bay does not proxy the session
   - it returns a structured response telling the browser where to reconnect
   - the browser reconnects to the home bay and retries sign-in using a retry
     token

### Post-Sign-In Control Connection

After sign-in completes on the home bay:

- the browser opens its long-lived control-plane websocket/API connection to
  the home bay hostname
- the visible page remains at `https://SITE_DNS`
- project-local runtime traffic still uses direct project-host connections

## Wrong-Bay Sign-In Recovery

### Chosen Model

Use structured recovery with:

- `home_bay_url`
- a short-lived retry token

This is preferred over plain error strings and preferred over server-side
proxying.

### Required Response Shape

When a sign-in request lands on a non-home bay, that bay should return a
machine-readable response similar to:

```json
{
  "wrong_bay": true,
  "home_bay_id": "bay-1",
  "home_bay_url": "https://bay-1-lite4b.cocalc.ai",
  "retry_token": "<short-lived signed token>"
}
```

The exact field names can change, but the semantics must be:

- this sign-in attempt is valid but on the wrong bay
- here is the destination home bay URL
- here is a short-lived token that authorizes replay of this exact sign-in
  attempt on the correct bay

### Retry Token Requirements

The retry token must be:

- short-lived
- signed
- single-purpose
- bound to the account or email being signed in
- bound to the target home bay
- safe to present from browser to the correct bay

The token must not become a general bearer credential.

### Browser Behavior

When the browser receives a wrong-bay sign-in response:

1. it opens a control-plane connection to `home_bay_url`
2. it replays sign-in using the retry token
3. the home bay validates the token and completes the real sign-in
4. the home bay sets cookies for the appropriate domain scope
5. the browser transitions to the signed-in state without surfacing the wrong
   bay detail as a user-facing error

### Failure Handling

If reconnect/retry fails:

- the browser should show a clear auth/bootstrap error
- the original sign-in credentials should not be silently retried in a loop
- the UI should offer a fresh sign-in attempt

## Signup Home-Bay Selection

### Current Gap

Current signup behavior assigns `home_bay_id` to the current bay.

That is not the desired final behavior.

### Required Policy

Signup must choose `home_bay_id` automatically using:

1. region preference
2. current bay load

### Region Heuristic

The system should estimate the user's region using existing ingress/request
metadata available at the public entry layer.

The chosen home bay should strongly prefer a bay in or near the user's region.

### Load Heuristic

Among acceptable region candidates, prefer the bay with the best current load
state.

This should use coarse current load signals, not overly fine-grained unstable
metrics.

Examples of acceptable signals:

- active session count
- recent control-plane latency
- queue/backlog pressure
- operator-configured admission weight

### Signup Flow

1. User submits signup at `https://SITE_DNS`.
2. Entry bay evaluates candidate home bays using region and load.
3. The chosen `home_bay_id` is fixed before account creation.
4. If the chosen home bay is local:
   - create the account locally
5. If the chosen home bay is remote:
   - create the account directly on that home bay using the existing inter-bay
     account creation plumbing
6. The browser then signs in against the new home bay using the same structured
   retry/bootstrap machinery as above.

### Consistency Requirement

The chosen home bay must be stored as the authoritative `home_bay_id` at
account creation time. It must not be implicitly inferred later from which bay
received the signup request.

## Cookie And Origin Model

### Cookie Scope

Cookies must work across:

- `SITE_DNS`
- `bay-N-SITE_DNS`

So cookie domain behavior must be derived from the configured site DNS and must
support the stable site plus bay subdomains.

This is required for seamless auth/bootstrap across the public site and the
home-bay hostname.

### Important Constraint

The system must not assume a hardcoded domain like `.cocalc.com`.

Launchpad customers provide their own site DNS.

Cookie scope must therefore be derived from configuration, not embedded as a
product constant.

### Websocket/API Origin Model

The browser page origin remains `https://SITE_DNS`.

The control-plane websocket/API target may be `https://bay-N-SITE_DNS`.

This cross-subdomain setup must be treated as a first-class supported case.

Implementation work must audit:

- websocket auth/origin checks
- cookie SameSite behavior
- CSRF assumptions tied to same-origin requests
- frontend API base URL calculation

## Bay DNS Lifecycle

### Responsibilities

The seed bay manages:

- create bay DNS records
- update bay DNS records on bay IP/origin changes
- delete bay DNS records when bays are removed

### Trigger Points

Bay DNS setup should happen when:

- a bay first joins the cluster
- a bay's public origin changes
- a bay is removed or decommissioned

### Desired Operator UX

Creating or joining a new bay should not require:

- manually copying Cloudflare API credentials to that bay
- manually creating bay DNS records
- manual hostname design decisions per bay

The seed bay should apply one deterministic naming rule and manage DNS
centrally.

## Browser-Facing API Requirements

We will likely need an explicit bootstrap/auth API surface that can return:

- stable site metadata
- resolved home bay info
- bay control-plane URL
- wrong-bay retry instructions

At minimum we need:

1. a bootstrap resolver for public entry
2. a structured wrong-bay sign-in response
3. a sign-in completion path using retry tokens

## Required Backend Capabilities

To support this model, backend implementation must provide:

- account home-bay resolution by email or account id
- signup-time home-bay selection using region + load
- inter-bay account provisioning on the chosen home bay
- signed short-lived retry tokens for wrong-bay sign-in
- bay hostname derivation from configured site DNS
- seed-bay-managed bay DNS lifecycle

## Non-Goals

This spec does not require:

- browser-visible redirects between bay URLs during normal operation
- server-side proxying of browser control traffic through the wrong bay
- changing direct project-host runtime traffic to go through bays
- solving account rehome as a polished operator workflow in the same change

## Implementation Sequence

Recommended order:

1. Add bay hostname derivation from configured site DNS.
2. Add seed-bay bay-DNS lifecycle management.
3. Add a small public bootstrap/auth response shape that can describe the home
   bay and bay URL.
4. Add wrong-bay sign-in structured response with retry token.
5. Update frontend sign-in flow to reconnect to the home bay and replay sign-in
   using the retry token.
6. Update signup to choose `home_bay_id` using region + load.
7. Update signup to provision the account on the chosen home bay.
8. Audit cookie/origin/websocket behavior across site and bay subdomains.
9. Validate end to end with:
   - public site on one bay
   - account home on another bay
   - project ownership on a third bay
   - project host on a fourth possible bay if available

## Acceptance Criteria

This spec is implemented when all of the following are true:

- a user can visit `https://SITE_DNS` and sign in successfully even if their
  account is homed on a different bay
- the browser does not show a wrong-bay auth error in the normal case
- the browser control-plane connection ends up on the account home bay
- the visible browser URL remains on the stable public site URL
- new accounts are assigned to a bay using region + load heuristics
- remote-home-bay account creation works without manual per-bay DNS work
- bay DNS records are managed by the seed bay
- direct project-host runtime connections remain separate and continue to work

