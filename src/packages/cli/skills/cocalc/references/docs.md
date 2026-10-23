# CoCalc docs

Part of the CoCalc skill (`../SKILL.md`). In examples, `cocalc` stands for the CLI command the runtime gives you.

## CoCalc Docs First

Use the docs CLI exactly as exposed by `cocalc docs --help`. Do not invent nested
commands such as `cocalc docs project secrets`.

Recommended lookup flow:

```bash
cocalc docs search "project secrets" --json
cocalc docs show projects/project-secrets --json
```

If the docs entry includes an action id, inspect it when relevant:

```bash
cocalc docs action settings.environment.secrets --json
cocalc docs actions --json
```

For UI tasks in the live browser session, prefer stable docs actions over raw
browser scripts:

```bash
cocalc browser action docs-list
cocalc browser action docs settings.environment.secrets
```

Use docs actions when the user asks you to open the UI, when opening the UI
would materially help, or when verifying that the docs still match the product.
If the user only asks for an explanation, summarize the docs and mention the
action id rather than opening UI without a reason.

When answering from docs:

- Always read `docs show <slug-or-id>` for the selected result before answering.
- Prefer the highest-scoring directly relevant result, not just the first broad match.
- Include the stable action id when the entry has one.
- Do not repeat examples from memory if the shown docs say something different.
- If the docs are stale or contradict the visible product, say that plainly and
  verify with browser actions or source inspection before giving final guidance.

Adding, replacing, deleting, or copying a project secret requests a runtime
refresh without requiring a project restart. A saved change is not proof that
the running mount was updated: inspect the returned `runtime_refresh` status.
A host can cache the change for the next start or report `retry_pending` when
the runtime refresh has not been confirmed. Recheck the runtime refresh before claiming the
new value is active. A program that already cached a credential may still need
its own reload. Never advise a project restart merely to apply a secret update.

Example answer shape for a usage question:

```text
The docs page `projects/project-secrets` says to edit this in Settings ->
Environment -> Secrets. The stable action id is
`settings.environment.secrets`, which can open that panel in the current browser
session.
```
