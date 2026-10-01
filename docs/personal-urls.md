# Personal URLs

Personal URLs are names for existing owners, projects, and content, not access
grants. Changing a username does not change account or project UUIDs. Renamed or
cleared usernames remain reserved as redirects until an administrator releases
them; clearing a username is not a way to transfer it to another account.

Links have the form `/u/USERNAME-OR-ACCOUNT-UUID/KIND/ALIAS`, where `KIND` is
`agents`, `artifacts`, `chats`, or `people`.

The aliases are the ones you already set: `@alias` on a conversation or person
in People (`chats`, `people`), personal agent names (`agents`), and Library
aliases (`artifacts`). The alias dialog in People shows the link to copy. A
username is optional (Settings → Account); the account UUID always identifies
the same namespace. Aliases remain editable shortcuts, not immutable resource
identities. Unqualified alias URLs are not supported as shared links.

Opening a link in the browser resolves it and then shows the target at its
normal address. If the viewer is not a collaborator on the target's project,
the project's access page offers the usual access request.

## Ownership And Deployment

The seed bay holds the unique username registry and redirect-release audit log.
Alias bindings remain at the owner's account home bay, including when the viewer
has a different home. Actual resource authorization is checked as the viewer at
the project's owning bay. Account rehome fences cover alias reads; resolving a
foreign URL never impersonates its owner or starts an agent/project.

Deploy the updated hub/schema and frontend together. A frontend-only rebuild
cannot provide the new `personalUrls` API or username tables. The registry is
seed-global; it is not copied as account-home state during account moves.

## Manage Your Username

Use your normal CLI login/profile:

```sh
cocalc account username get --json
cocalc account username set alice --json
cocalc account username clear --json
```

These return `account_id`, the current `username` (or `null`), and `redirects`.
The server validates username syntax, reserved names, and availability. Set and
clear always affect the authenticated account, not an owner inferred from a URL.
There is a limit of 32 retained names per account, including the current name.
Clearing the current name or returning to a retained name remains possible at
the limit; old redirects are never silently released to make room.

## Resolve A Link

```sh
cocalc --profile support url resolve 'https://cocalc.ai/u/alice/artifacts/report' --json
```

The CLI returns the server's `ResolvedPersonalUrl` unchanged in the standard
JSON envelope's `data` field. Resolution uses control-plane metadata, not project
startup or content reads. Normal callers can resolve only content the server
authorizes; knowing a username, URL, UUID, or resolved path does not grant access.

Results include `owner` (`account_id`, current `username`, and `redirect`), `kind`,
`alias`, `canonical_path`, and `status`. A `resolved` result includes a typed
`target`: agent/project IDs, artifact entry/project IDs, conversation resource/
project IDs, or a person ID, with authorized chat path/thread IDs when available.
`unavailable` and `access-denied` results have no content locator; a denied link
may include `project_id` for the existing access-request flow. These are successful
resolution responses, so scripts must check `data.status`, not just `ok`.

The input URL is lookup data only. Its host never selects a backend or receives
CLI credentials. Choose the deployment with `--profile` or `--api`; other normal
authentication flags are preserved. A public-facing URL may be resolved through
an explicitly configured local API for that same deployment. Resolution errors
are not retried through another account, backend, or privileged inspection API.

## Admin Support

For explicit admin-only diagnostics, including a minimal locator when the admin
is not a project member:

```sh
cocalc url resolve 'https://cocalc.ai/u/alice/artifacts/report' --inspect --json
```

The server checks admin authorization. An `inspection` result is metadata only,
not a content grant. Normal resolution never silently falls back to inspection.
`people` aliases are private nicknames: only their owner or explicit admin
inspection can resolve them; they are not a public person lookup.

Inspect the username/redirect record for a resolved owner UUID:

```sh
cocalc admin username inspect OWNER_ACCOUNT_UUID --json
```

For further investigation, use existing authorized admin diagnostics with the
returned IDs, for example:

```sh
cocalc admin db project --project-id PROJECT_UUID --reason 'support ticket 123' --json
```

Resolving a link does not impersonate its owner or grant file access. Admin
inspection and content access remain governed by their existing API permissions.

To release a retained redirect for reuse, first inspect it, obtain browser-approved
fresh authentication, then name the exact owner, redirect, and audit reason:

```sh
cocalc auth elevate
cocalc admin username release-redirect OWNER_ACCOUNT_UUID old-alice \
  --reason 'support ticket 123' --yes --json
```

Release requires admin authorization and a fresh cookie-backed session; API keys
and bearer tokens cannot replace fresh authentication. `--yes` confirms the
release but grants no permissions. Releasing a redirect can break old links and
allow the name to be claimed again, so do not use it as routine username cleanup.
