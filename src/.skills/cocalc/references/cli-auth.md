# CoCalc CLI, Browser, And Auth

## CLI Rule

Use the exact command from the runtime guidance. In Launchpad project runtimes it
is usually:

```bash
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"
```

Do not assume bare `cocalc` resolves to the correct binary.

Prefer scoped environment variables when present:

- `COCALC_PROJECT_ID`
- `COCALC_BROWSER_ID`
- `COCALC_API_URL`
- `COCALC_BEARER_TOKEN`

## Browser State

For open files/tabs, start with:

```bash
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" browser files \
  --project-id "$COCALC_PROJECT_ID" \
  --browser "$COCALC_BROWSER_ID"
```

Use `browser workspace-state` for workspace records and selection state. Use
`browser exec` only for UI-only information that typed CLI commands cannot
answer.

Always pass explicit project and browser targets under agent auth. Session
discovery can be blocked or ambiguous.

## Live Text Files

For files that may be open in CoCalc's collaborative editor, use the backend
sync/session API instead of reading or writing the file directly.

Read example:

```bash
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" exec \
'const doc = api.text.open({ path: "/home/user/file.md", projectIdentifier: process.env.COCALC_PROJECT_ID }); return await doc.read();'
```

Append example:

```bash
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" exec \
'const doc = api.text.open({ path: "/home/user/file.md", projectIdentifier: process.env.COCALC_PROJECT_ID }); const before = await doc.read(); return await doc.append("\nAgent note", { expectedHash: before.hash });'
```

The text API saves to disk by default. Use `saveToDisk: false` only for
intentional live-only collaborative edits.

## Auth Boundaries

Project-scoped agent auth is powerful inside the current project but not a
full admin session. If an error includes `auth_actor: "agent"` and scopes like
`["browser_session","project_session"]`, expect these to fail:

- creating fresh projects
- publishing official RootFS images
- admin mutations that require fresh auth
- site-wide control-plane operations

Give the user the admin-authenticated CLI/UI path instead of retrying with the
same token. Fresh-auth operator work needs an interactive cookie-backed session,
not a project bearer token or API key.
