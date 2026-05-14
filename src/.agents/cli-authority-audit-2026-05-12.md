# CoCalc CLI Authority Audit

Status: first pass completed, 2026-05-12.

Scope: `src/packages/cli/src/bin`, `src/packages/cli/src/core`, and the CLI
API bindings under `src/packages/cli/src/api`.

## Credential Model

`cocalc-cli` can authenticate through several distinct paths:

| Credential class        | Source                                                                           | Intended authority                                                        |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Browser-approved cookie | `auth login`, stored profile cookie                                              | Account session; can carry `auth_session_hash` and freshness/2FA metadata |
| Account API key         | `--api-key`, `COCALC_API_KEY`, stored profile                                    | Account API authority; currently broad unless key scopes restrict it      |
| Bearer/agent token      | `--bearer`, `COCALC_BEARER_TOKEN`, `COCALC_AGENT_TOKEN`, Lite metadata           | Agent/session authority determined by token claims                        |
| Project secret          | `COCALC_PROJECT_SECRET`, `project_secret`, `COCALC_SECRET_TOKEN` plus project id | Current-project authority only                                            |
| Hub password            | `--hub-password`, `COCALC_HUB_PASSWORD`                                          | Site/operator authority; can bootstrap an account session                 |
| Local-only              | No remote credential                                                             | Auth profile management, local daemon control, product wrapper commands   |

Important mechanics:

- Profiles override ambient auth and set `disableEnvAuthDefaults=true`.
- Ambient env auth is otherwise enabled by default for developer/agent
  workflows. The CLI now exposes `--disable-env-auth-defaults` so a caller can
  force profile/flag-only auth.
- `hubCallByName` forwards `auth_session_hash` when the signed-in remote user
  has one. Dangerous-action freshness must still be enforced server-side by the
  hub API method.
- Project-scoped auth intentionally gets a fallback account id locally so
  current-project commands can run; hub/project-host authorization must still
  reject account-only APIs for project identities.

## Command Family Matrix

| Family                             | Examples                                                                                              | Minimum intended authority                                      | Notes / release risk                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Local auth/profile                 | `auth status`, `auth list`, `auth login`, `auth setup`, `auth use`, `auth logout`, `auth elevate`     | Local filesystem; login/elevate also uses public auth endpoints | Stores bearer/API/cookie/hub secrets. Config file is now forced to `0600`.                                                    |
| Local daemon                       | `daemon start`, `daemon stop`, daemon-backed `project file ...`                                       | Same local OS user                                              | Daemon caches remote contexts. Runtime directory is now `0700`; socket and pid file are `0600`.                               |
| Product wrappers                   | `plus`, `launchpad`                                                                                   | Local OS user                                                   | Runs local product binaries/installers; no remote auth by itself.                                                             |
| Account self/service               | `account where`, `account membership`, `account egress`, `account api-key ...`                        | Account session/API key; some paths admin for another account   | API-key scope lockdown remains `SEC-KEY-001`.                                                                                 |
| Account destructive/admin-adjacent | `account delete`, `account rehome`, `account repair-membership`                                       | Account owner or site admin depending on target/server policy   | Should rely on server-side dangerous-action checks. Needs endpoint-level freshness inventory.                                 |
| Project metadata/lifecycle         | `project list/get/create/rename/start/stop/restart/delete/undelete`                                   | Account project membership; owner/admin for destructive actions | Hard delete has CLI confirmation. Server must enforce membership, ownership, and freshness for dangerous variants.            |
| Project shell/files                | `project exec`, `project ssh`, `project file ...`, `tasks ...`                                        | Project member or matching project-scoped secret                | High power inside one project. Project-scoped auth is appropriate, but commands must not escape to account/admin APIs.        |
| Project notebooks/terminal         | `project jupyter ...`, `project terminal ...`                                                         | Project member or matching project-scoped secret                | Can execute code or write terminal input in the project; project-host admission/caps are the main DoS guard.                  |
| Project Codex/chat automation      | `project codex exec`, `project chat automation ...`                                                   | Project member or matching project-scoped secret                | ACP queue admission now guards durable turns; automation-specific caps remain follow-up under `SEC-ACP-003`.                  |
| Project apps/public exposure       | `project app upsert/delete/expose/unexpose/forward...`                                                | Project owner/admin or project service capability               | `expose --front-auth none` is intentionally public exposure; should be treated as dangerous and freshness-worthy server-side. |
| Project backups/snapshots/rootfs   | `project backup ...`, `project snapshot ...`, `rootfs publish`                                        | Project owner/admin; rootfs admin flags require site admin      | Data export/restore and image publication are high impact; server policy is authoritative.                                    |
| Browser session automation         | `browser files`, `browser action ...`, `browser exec ...`, `browser audit ...`, `browser session ...` | Account with browser session or scoped agent/session credential | Raw JS is admin-setting gated and default-disabled; per-tab caps and local audit are in place from `SEC-BROWSER-001`.         |
| Admin/site operations              | `admin ...`, `host ...`, `bay ...`, `rootfs admin-list/hide/block/gc`, `membership assign/revoke`     | Site admin / operator credentials                               | Broadest authority surface. CLI does not prove admin itself; hub APIs must reject non-admin identities.                       |
| Load/dev/diagnostics               | `load ...`, `dev ...`, `op ...`, `notifications projector/drain/rebuild`                              | Developer/operator/admin depending on method                    | Useful for testing and ops; potentially high load. Should not be exposed through weak API keys or project-scoped auth.        |
| Generic backend exec API           | `exec-api`, `exec`                                                                                    | Same authority as underlying namespace calls                    | Broad composition surface over tasks/text/timetravel/export/import/workspaces; should remain scoped by underlying APIs.       |
| Import/export                      | `export ...`, `import ...`                                                                            | Account/project access to referenced data                       | Can move data across files/bundles. Server-side project/file permissions are authoritative.                                   |
| Workspaces/notifications           | `workspaces ...`, `notifications ...`                                                                 | Account/session; selected projector paths are operator/admin    | Notification projector controls should remain in endpoint-level dangerous-action inventory.                                   |

## Findings From This Pass

### CLI secret files were not forced private

The auth config can store cookies, account API keys, bearer tokens, and hub
passwords. `saveAuthConfig` previously relied on process umask/default file
modes. It now creates the config directory with `0700` and forces the config
file to `0600` on every save.

### CLI daemon transport needed explicit local privacy

The daemon caches authenticated command contexts and accepts project file
actions over a Unix socket. The transport now forces the daemon runtime
directory to `0700` and the socket/pid file to `0600`. This keeps the daemon as
a same-local-user acceleration path rather than a same-host multi-user
authority leak.

### Ambient env auth is powerful and now easier to disable

Ambient auth is important for agent and developer workflows, but it can make a
CLI invocation more privileged than expected. The new
`--disable-env-auth-defaults` global option disables `COCALC_*` auth fallback
for a single invocation.

### Dangerous-action enforcement is not centralized in the CLI

The CLI forwards `auth_session_hash`, but most command modules do not declare
which operations require freshness/2FA. That is acceptable only if each hub or
project-host endpoint enforces its own dangerous-action policy. The next audit
step should inventory endpoint-level checks for the dangerous rows in the matrix
above.

### API key scope is now fail-closed by default

Account API keys now require explicit capabilities and project allowlists.
HTTP bridge calls have a small reviewed allowlist, and API-key websocket hub RPC
is denied until function-level auth metadata is propagated through dispatch.
Treat future CLI/API-key support as opt-in per command family, not as full
account login.

## Recommended Follow-Ups

1. Extend API-key support only where there is a concrete use case, starting
   with audited project/file/Codex operations on explicitly allowed projects.
2. Add or verify server-side freshness/2FA checks for dangerous command
   families: account deletion/rehome, project hard delete/restore/public app
   exposure, rootfs admin mutation, host mutation, membership assignment, org
   token lifecycle, and CLI-issued auth tokens.
3. Consider central audit events for `hub_password` account bootstrap,
   `admin user issue-impersonation-link`, and browser/session automation use from the
   CLI.
4. Consider a hidden `cocalc audit authority` command later that emits this
   matrix from structured metadata instead of a hand-maintained document.
