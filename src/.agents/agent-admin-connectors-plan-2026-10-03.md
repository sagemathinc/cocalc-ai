# Admin connectors: agents as site admins

Status: plan, revised 2026-10-03 after a security review
(`/home/user/reviews/agent-admin-access-plan-review-2026-10-03.md`) and
William's direction. Applies to cocalc.ai and CoCalc Star alike.

## Goal

An admin tells an agent "investigate all support tickets", "find out why
this notebook is inconsistent" or "make a release", grants it the access that
task needs once, and the agent works without per-command approval. Every
admin call is audited with the agent's own reason. Acting on users (support
replies, account repairs) follows a simple loop: the agent reads and
investigates, proposes a list of actions, the human approves the list, the
agent carries it out. A short list of operations always needs approval one
at a time.

It has to be simple. A model that is complicated to grant or to work with
will not be used: admins will keep giving agents full account credentials
(today's workaround), which is far worse than any limited model.

## Security model

What it protects against, and what it does not.

**Trust boundary: the admin's own single-user project.** An admin connector
can only exist in a project whose only user is the granting admin. The
server checks this when the grant is made and at the start of every turn;
adding a collaborator revokes the grant. Everything in that project (the
agent, terminals, the admin's own code) is treated as the admin. This is the
same trust a human admin already gives their own laptop or terminal.

**What is protected:**

- **Other users of the project and of the site.** No collaborator, and no
  other project, can obtain or use the admin connector.
- **Scope.** The agent can do only what its level allows, for as long as the
  grant lasts. Revocation, expiry and the admin losing admin status take
  effect on the next call.
- **Accountability.** Every admin call records the agent, its turn, the
  granting admin, the method, its targets and the agent's reason.
- **High-impact identity, access and cost operations** (2FA removal, granting
  access to another account, admin role changes, creating or deleting
  project hosts, large refunds) never run on the level alone: each needs its
  own approval, as a careful human support team would double-check them.
- **Secrets.** Admin reads never return secret-bearing data (API key and
  token tables, stored credentials, secret site settings): those are
  excluded or redacted on the server.

**What is not protected, by design:**

- **Prompt injection through ticket text and similar content.** A support
  request can try to talk the agent into something, exactly as people try
  with human support staff. This is bounded, not eliminated: by the level,
  by the human approving the proposed actions before anything is done to
  users, by the always-approved list, and by the audit trail. Designing as
  if any ticket can make the agent do anything would make support
  impossible to run.
- **The admin's own project.** Anything running in it can use the connector
  while the grant is active, just as anything in a human admin's terminal
  session can use that session. Keep admin projects single-purpose.

## How it works

### The connector key

The per-turn connector key is today written to
`~/.local/share/cocalc/runtime/.../connector-key`, inside HOME, so it is
snapshotted and backed up. Move it to a read-only mount outside HOME
alongside project secrets (`/run/secrets/cocalc`), for example
`/run/cocalc/connector/<turn>`. This applies to all connectors, admin or
not.

### Grants

One admin grant per (admin account, agent, project), stored on the account's
home bay:

- `level`: `admin:read`, `admin:support` or `admin:operate`;
- `expires_at`: the admin picks this turn, some hours, a day, or until
  revoked;
- `created_at`, `created_by`, `revoked_at`.

Creating a grant needs fresh authentication (and second factor if enabled)
once, at that moment. It is never part of the generic API key or connector
scope: those paths reject admin capabilities.

### Levels

| Level | Allows without further approval |
|---|---|
| `admin:read` | reading tickets and crash reports, logs, host status, deploy status, admin data, and audited read-only SQL with secret tables excluded |
| `admin:support` | everything in read, plus carrying out an approved list of support actions: ticket replies, account repairs, small refunds |
| `admin:operate` | everything in read, plus host upgrade, reconcile, restart and rollout, software releases, non-secret site settings |

Always approved one at a time, at any level: 2FA removal, password or email
changes, granting access to another account, admin role changes, creating or
deleting project hosts, deleting projects or data, refunds above a limit,
secret site settings.

Every method an agent can call is listed explicitly with its level (or
"always approved", or "never"); anything not listed is denied to agents. A
regression test fails when a hub API method has no entry.

### The hub check

An agent's admin call goes through one check on the hub. The call is allowed
when:

1. the agent is authenticated with its turn's connector key, as today;
2. a live grant exists for (granting account, agent, project), not expired
   or revoked, and its level covers the method;
3. the granting account is still a site admin;
4. the project still has the granting admin as its only user;
5. for an action on users, it is on the currently approved list (matched by
   its targets: ticket, account); for an always-approved operation, it has
   its own approval.

The grant is read on each call (one indexed lookup, cached for a few
seconds at most), so revocation is immediate in practice. The call then runs
with the admin's authority, but the agent is never turned into the human:
the request carries both identities (agent and turn; granting admin and
grant), and that is what handlers and audit see. Methods that are human-only
today stay human-only.

### The support loop

1. The agent reads tickets and investigates (read level).
2. It proposes a list of actions: for each, the method and its targets, and
   for replies the text. The list is stored on the server and shown to the
   admin (a proposed-actions card).
3. The admin approves the list (or some of it). One approval.
4. The agent carries out the approved actions. Each call is checked against
   the approved list by method and targets; actions not on it are refused.
   The list expires with the turn.

Approving a list does not raise the level for unrelated actions.

### Audit

Each admin call, allowed or denied, records: time, agent, project, turn,
granting admin, grant, level, method, targets, approved-list item if any,
the agent's reason, and the outcome. No secrets, query results or ticket
bodies. If the audit record cannot be written, write operations fail; reads
log the failure.

### Visibility

Agents holding an admin grant show a badge in the agents list, the thread
header and the composer. An admin page lists active grants (agent, project,
level, expiry, last use) with revoke.

## First steps

1. Move the connector key to a read-only mount outside HOME (all
   connectors).
2. Grant table, the hub check, both identities and the audit record, with
   `admin:read` only. This alone replaces today's full-credential workaround
   for investigation (for example the sync-inconsistency query).
3. Grant UI: level and duration with fresh authentication; the single-user
   project check; badges; the admin page.
4. The support loop: stored proposed-action lists, approval, and the check
   against them; `admin:support`.
5. `admin:operate` and the always-approved operations.

## Tests

- A grant cannot be created in a project with collaborators, and adding a
  collaborator revokes it.
- Calls fail after revocation, expiry, the admin losing admin status, or the
  turn ending.
- Unlisted methods and human-only methods are denied to agents; the generic
  API key and connector paths reject admin capabilities.
- Actions not on the approved list, or with other targets, are refused.
- Secret tables are not readable through admin SQL.
- Every allowed and denied call has an audit record without secrets.

## Not in this version

Kept out deliberately to stay simple, and revisited only if needed: signed
single-use assertions between bays (the first version runs admin calls on
the account's home bay, which is also the only bay of a CoCalc Star site),
per-request cryptographic action manifests, and a separate isolated
operator workspace (the single-user project is the boundary).
