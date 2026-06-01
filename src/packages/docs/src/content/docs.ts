/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const DOCS_BROWSER_BODY = String.raw`
## What the docs browser is for

The CoCalc-ai docs browser gives each running CoCalc instance its own built-in
documentation. This matters because the docs should match the version of CoCalc
you are actually using instead of sending you to stale external documentation.

## Open docs

1. Open the public **Docs** page, or open **Docs** inside a project.
2. Search for a task, feature, or action id.
3. Open the matching entry.
4. Use any available action button when the docs can open the relevant UI for
   you.

Inside a project, the docs can appear as a flyout or a full project tab. Public
docs use the same content but do not have project-scoped browser actions.

## Adjust readability

Use the docs font size control when you need larger or smaller text. The setting
is saved locally in the browser so docs stay readable without zooming the whole
CoCalc interface.

## Why this matters in CoCalc

Docs are part of the product runtime. They can be searched by humans, consumed
by agents, and verified against the current UI, which makes them less likely to
drift away from reality.
`;

export const DOCS_ACTIONS_BODY = String.raw`
## What executable docs actions are for

Executable docs actions are stable identifiers for UI destinations. Instead of
only saying "open Settings, then Environment, then Secrets", a docs entry can
also name \`settings.environment.secrets\`, and CoCalc can open that panel in
the current browser session.

## Use an action id

1. Open a docs entry that lists an action.
2. Click the action button, or ask Codex to use the action id.
3. CoCalc opens the matching project UI when the action is implemented and
   available.
4. If the action is not implemented yet, use the written steps.

Agents can list actions with \`cocalc browser action docs-list\` and execute one
with \`cocalc browser action docs <action-id>\`. Parameterized actions accept
\`--param key=value\`; project-host actions also accept \`--host-id <id>\`.

## Verify actions

Docs actions should be tested with browser-session verification. The verifier
does not only check that the action returned success; it also asserts that the
expected visible UI appeared.

## Why this matters in CoCalc

Executable docs turn documentation into a bridge between explanation and action.
That is especially valuable for Codex: it can answer a question, open the right
panel, and then continue working in the same project context.
`;

export const BROWSER_AUTOMATION_BODY = String.raw`
## What browser-session automation is for

Browser-session automation lets Codex and other agents safely operate a
restricted set of actions in the exact browser session that asked for help. It
is useful for opening panels, checking visible UI, reading state, and validating
that docs match the product.

## Use the browser session

1. Load the matching dev environment before using \`cocalc browser\`.
2. List browser files or docs actions when you need context.
3. Use high-level actions such as docs actions before falling back to generic
   browser exec scripts.
4. Use assertions such as waiting for text or a URL when verifying behavior.

For local hub development, refresh the environment with
\`cd src && eval "$(pnpm -s dev:hub:env)"\` before live browser commands.

## Keep automation scoped

Prefer typed actions and restricted QuickJS browser exec APIs over raw DOM
scripts. The goal is enough UI access for useful help and verification, not an
unbounded remote-control surface.

## Why this matters in CoCalc

The same infrastructure that lets Codex open a Secrets modal can also verify
that docs are still true after frontend changes. This makes documentation,
support, and agent behavior part of one testable system.
`;
