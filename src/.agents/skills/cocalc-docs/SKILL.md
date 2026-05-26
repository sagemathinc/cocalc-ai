# CoCalc Docs

Use this skill when answering user-facing questions about how to use CoCalc-ai
or when opening a documented CoCalc UI destination for the user.

Prefer the versioned docs bundled with the current checkout before reading
source code or guessing from memory. In this repository, run commands from
`/home/user/cocalc-ai/src` unless the user provides a different checkout.
When the CoCalc runtime requires an exact CLI path, use
`"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"` in place of bare
`cocalc`.

## Workflow

1. Search the bundled docs:

   ```sh
   cocalc docs search "<query>" --json
   ```

   When the user is asking about site administration, include admin-only docs:

   ```sh
   cocalc docs search "<query>" --include-admin --json
   ```

2. Read the most relevant page:

   ```sh
   cocalc docs show <slug-or-id> --json
   ```

3. If a page has an action id and the user asks to open that UI, prefer the
   docs action path instead of selector automation:

   ```sh
   cocalc browser action docs <action-id> --project-id "$COCALC_PROJECT_ID" --browser "$COCALC_BROWSER_ID"
   ```

4. If the docs are missing, stale, or ambiguous, say that clearly, then inspect
   source code or visible UI to resolve the answer.

5. If you discover an important missing docs page, propose adding it to the
   docs plan or legacy docs inventory.

## Important Command Shape

Do not invent nested docs commands such as `cocalc docs project secrets`.
The stable commands are:

```sh
cocalc docs list
cocalc docs search "<query>"
cocalc docs show <slug-or-id>
cocalc docs actions
cocalc docs action <action-id>
cocalc docs verify
```

Use `--json` when the answer benefits from exact ids, slugs, action ids, or
machine-readable metadata.
Use `--include-admin` only for admin/operator questions.

## Answering Style

When summarizing docs, include the docs page title/slug and any relevant action
id. If the page describes behavior that depends on the live app, mention that
the docs are versioned with the running CoCalc-ai deployment.
