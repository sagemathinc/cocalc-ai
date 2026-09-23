# Cross-Project Agent CLI Connections

Date: 2026-09-23
Status: proposal for review; no implementation approved by this document

## Decision To Review

Agent X runs in project A. A human enables project B as a connection for X.
During that human's turns, X can use the ordinary CoCalc CLI against B in one
of two modes:

- **Full access:** the CLI access an ordinary agent running in B would have when
  run by that human. This includes execution and the resulting access to B's
  filesystem, secrets and network, subject to existing agent CLI restrictions.
- **Read files:** the file listing and reading access a human viewer of B would
  have, limited to the directories the human selected. No execution or write
  access in B. Use the existing viewer filesystem policy and service.

In this first version, the human must be a current owner or full collaborator
of both A and B to configure **either** mode and to use it. A human who only has
viewer access to B cannot create this connection. The connection does not add X
or the human to B's collaborator list. X keeps its identity and conversation in
A; it does not become one of B's named agents or inherit another agent's
connections. The human's account is the responsible principal for X's turn.

The product can describe this as **Give this agent access to another project**.
The choices are **Full agent access** and **Read selected files**. Avoid a third
term such as "File Grant" in the UI. The `+` menu and agent Access panel should
show B's title, mode and selected directories without exposing its UUID.

This plan supersedes the File Grants and proposed separate Execution Grants in
[the connector roadmap](agent-connectors-implementation-plan-2026-09-19.md)
for cross-project access. PR #662 is unmerged; keep its VM toolbox work, but
replace its cross-project File Grant implementation before merging. This plan
does not require deleting useful tests or viewer-policy helpers until their
replacement is working.

## What The Human Is Approving

The saved connection belongs to `(human, agent X, A, B)`, not everyone who
collaborates on A or everyone who runs X. It stays available across the human's
turns until removed, but a usable credential exists only for that human's
active run. A collaborator starting a different turn with X sees their own
connections. Selecting B for one turn does not silently grant it to another
human or another named agent.

The Access panel presents this summary before saving:

> Give this agent access to **B** when you run it. You must remain a collaborator
> on both projects. Access ends when your run ends or you remove this connection.
> Project processes and collaborators in **A** may be able to use its temporary
> credential while the run is active.

For **Full agent access**, add:

> The agent can use the same CoCalc CLI project capabilities it would have while
> running in **B**, including commands that execute code or change files. It can
> read B's project files and credentials. Changes and jobs may outlast the run.

For **Read selected files**, list the exact directory roots and add:

> The agent can list and read these files through B's viewer service. It cannot
> write or execute in B using this connection. The ordinary viewer exclusions
> and file policies apply; do not imply that selecting a directory overrides
> those exclusions.

These are the boundaries CoCalc enforces. This is not per-process isolation in
A: code and collaborators sharing A's runtime may read or copy an active
credential. It does not make B's own processes or collaborators untrusted-file
system tenants. In full mode, a process started in B can continue or leave
persistent changes. CoCalc cannot recall data already read, files already
changed, or external effects. Do not promise a complete per-command or per-file
activity log unless one has actually been built. Viewer mode restricts this
connection's credential; it cannot constrain a separate human CLI login,
project-local SSH key or other credential someone has put into A.

## CLI Contract

Use existing commands with an explicit target, for example:

```text
cocalc project file list --project B
cocalc project file cat --project B docs/report.md
cocalc project exec --project B -- <command>
cocalc project jupyter ... --project B
```

The CLI selects the credential for the resolved project on **each invocation**.
Omitting `--project` keeps A as the default. A command aimed at B must never
silently use A's credential, a local human login, an API key, or a broader
profile when B's connection is unavailable. The CLI reports why access is
unavailable: no connection, wrong mode, no longer a collaborator, run ended,
project stopped, or host unreachable. The project title can be resolved to a
stable project ID before authorization; errors need not disclose inaccessible
project names.

"Full" means the capabilities currently available to a normal agent CLI in
B. It is not a human account session: account, billing, admin, fresh-auth,
browser-login and unrelated connector operations remain subject to their
existing rules. Before launch, inventory ordinary CLI command families and
verify full-mode parity for files, execution, terminal, Jupyter and other
project-local operations that the UI advertises. Fix routing or authorization
gaps in those commands instead of adding a second cross-project command tree.

Viewer mode uses the same `project file list/cat/get` flow where supported.
Search is currently unavailable to CLI viewers and may follow later; the UI
must not promise it first. Other CLI commands to B fail clearly in viewer mode.
In particular, a generic `exec` or a notebook API cannot be a back door to
reading outside the selected directories.

## Authority And Credential Model

1. The authoritative bay for A verifies the human, X's stable identity and the
   active run. The authoritative bay for B verifies that same human's current
   owner/collaborator membership and the saved connection. A and B may belong
   to different bays or hosts; route by project ownership.
2. Store a small connection record on B's owning bay with human ID, X ID,
   source A, target B, mode, optional viewer roots, generation, status and
   creation/update times. It describes an agent's access to a project; it does
   not copy B's collaborator table or create a new file-operation authorization
   system. Have B's database invalidate affected records in the same
   transaction when P loses full collaborator access, regardless of which
   application path changes membership (including course reconciliation).
   A delayed cross-bay notification is insufficient. Move the record with B
   if B changes owning bays. A's bay supplies the active-run check.
3. Prepare a short-lived, renewable B credential for X's run. Its signed or
   server-validated identity must include B, B's current host audience, the
   human, X, A, the run, the connection generation and the mode. Issue it only
   after checking both projects and the run. Preserve B's existing agent
   principal restrictions. Never mint a human account credential for X.
4. Route normal full-mode project CLI traffic directly to B's project host.
   Route viewer-mode file traffic to the existing viewer filesystem service,
   using its read policy for the selected literal directory roots. Extend that
   service's policy lookup to recognize the authenticated agent connection and
   load its policy from B's connection record. Its current human-viewer lookup
   cannot work unchanged because P is a collaborator. Leave P's global role
   alone; the viewer credential selects the narrower subject and policy. Reuse
   the viewer filesystem implementation and read-only RPC allowlist.
5. At the project-host boundary, reject subjects outside B and the credential's
   mode. Confirm that A's ordinary agent credential cannot be used as a B
   credential, including when A and B happen to share a host. Bind or narrow
   existing agent credential handling as necessary; this is a prerequisite to
   claiming that viewer mode is enforced. A CLI-side mode check alone is not a
   security boundary.
6. Recheck the active run, connection generation and current B membership when
   admitting new B operations. Invalidate authorized-session caches on changes
   or use a bounded authorization lookup that cannot allow an old socket to
   retain access. If the relevant authority is unavailable, new B operations
   fail closed. Keep sustained file and process traffic on the direct
   project-host path, not through the hub.

The runtime can place the B credential alongside the existing agent CLI lease.
Treat the file as accessible to A's shared runtime; private file mode is not
per-agent isolation. Remove it at run end and stop renewal, but enforce run
and generation checks at the service because a process may have copied it.
Short token expiry is a backstop, not the revocation mechanism. Avoid a global
"current project B" environment variable or a broad multi-project bearer.

For viewer mode, reuse `ProjectViewerReadPolicy`, canonical path checks,
mandatory viewer exclusions and `fs-viewer`'s read-only method set. Select
literal directory roots, not globs. The policy is authoritative on B's host,
not in the CLI. There is no new writable file sandbox: full mode uses B's
ordinary project runtime and ordinary CLI commands.

## Revocation And The Six-Hour Example

At turn start, human P is a collaborator in A and B and X receives its B
credential. Six hours later P is removed from B:

1. B's authoritative membership change commits. Further B credential issuance
   and renewal fail. New B operations using an old credential are rejected,
   including over an established connection. X continues to work in A.
2. Mark the saved connection unavailable/revoked. If P is later re-added to B,
   require P to enable it again; do not reactivate an old connection or old
   credential merely because membership returned. A connection generation or
   membership epoch must make this testable across bays.
3. Previously admitted operations may finish. Work already started **inside
   B** is not automatically terminated by the membership change. To establish
   the existing stronger offboarding boundary, explicitly restart B and wait
   for that restart to succeed. A failed or queued restart is not a guarantee.

Restarting B does not terminate X in A. Conversely, removing the token file in
A or restarting A does not, by itself, revoke a token already copied from A.
B's server must refuse it. Restart also cannot undo prior changes or remove
project-local credentials and code left in B. These are the same limits as
ordinary collaborator offboarding, documented in
[the agent messaging release contract](agent-messaging-release-contract.md).

Ending X's run or removing the connection follows the same rule for **new** B
operations. Full-mode jobs already started in B may require B's project
restart if they must be stopped. State this in the UI rather than promising
that a chat turn can undo processes it launched.

## Implementation Sequence

1. **Freeze the current cross-project slice in PR #662.** Keep its tested VM
   toolbox work. Inventory File Grant files and tests; remove the separate
   `project file grant` commands, writable grant service, grant-specific schema
   and UI only after equivalent cross-project paths exist. Do not ship both
   models as overlapping choices.
2. **Audit an agent running in B.** Record which ordinary CLI commands work
   with its current agent credential, which need account authorization, and
   how B's viewer can list/read selected paths. Include same-host and
   different-host routing and the stopped-project case. Use that matrix to
   define the exact first release UI promise.
3. **Bind agent project credentials to their project.** Update token issuance,
   project-host and hub authorization, and CLI connection selection so a normal
   A credential cannot authorize B. Preserve existing same-project CLI
   behavior. This is necessary for a meaningful read-only mode and should be
   reviewed as an auth change on its own.
4. **Add connection configuration and issuance.** Reuse stable agent/run
   identity and the existing agent CLI lease lifecycle. Authorize P in A and B,
   record mode/generation, prepare B's audience-bound credential, and verify
   run and membership at B's operation boundary. Use the existing inter-bay
   routing layer. Avoid a new data-plane proxy.
5. **Connect the ordinary CLI.** Resolve the target project and choose its
   credential per call. Full mode reaches existing B services; viewer mode
   reaches B's viewer filesystem service. Extend viewer CLI verbs only where
   needed for the promised read workflow. Return precise permission errors.
6. **Adapt the `+` picker and Access UI.** Reuse the shared project selector.
   Save the human's connection for X, show mode and roots, and make removal
   straightforward. Show the concise warning above at the point of approval;
   put technical detail in help. Do not show UUIDs or make users enter them.
7. **Test offboarding before rollout.** Start a real X turn in A and use B in
   both modes. While it is running, remove P from B, attempt new operations
   using the same CLI process and a copied credential, re-add P, and verify the
   old connection stays unavailable. Restart B and verify old B jobs stop.
   Repeat with A and B on different hosts and bays. Include permission
   downgrade, run end, connection removal, host move, stale routes, and
   viewer path/alternate-CLI-method bypass tests.
8. **Review and replace the PR implementation.** Request focused security
   review of the changed agent auth, target-project binding, viewer subject
   restrictions and revocation behavior. Validate old clients fail closed
   during rollout. Remove obsolete File Grant documentation and migration code
   only after deciding how to handle development databases with saved grants.

This is a substantial auth and CLI change, but the product model is small:
**X may use B like an agent in B, or may read selected files like a viewer in
B, while P remains a collaborator and X's run is active.**
