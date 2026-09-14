/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const COCALC_CLI_BODY = String.raw`
## Automate CoCalc from a terminal or an agent

The CoCalc CLI provides commands for projects, files, collaborative documents,
notebooks, agent sessions, browser actions, and long-running operations.
Use it from your own computer or from a CoCalc environment with supplied
project or agent credentials.

## Start here

1. [Install and run your first command](/docs/cli/getting-started):
   install the CLI, sign in on your own computer, and list a project's files.
2. [Check authentication and targets](/docs/cli/authentication-and-targets):
   choose the site, account, project, and browser deliberately.
3. [Find the right command](/docs/cli/command-reference):
   navigate the available command families and typed APIs.
4. [Use the CLI in scripts](/docs/cli/scripting-and-results):
   parse JSON, check remote results, and recover existing operations.

## Practical workflows

- [Edit collaborative text with the CLI](/docs/cli/collaborative-text)
- [Run and save notebooks with the CLI](/docs/cli/notebook-workflows)
- [Test browser workflows with the CLI](/docs/cli/browser-workflows)
- [Schedule agent tasks with the CLI](/docs/cli/scheduled-agents)
- [Manage workspaces and notices with the CLI](/docs/cli/workspaces-and-notices)
- [Build documents and track CLI versions](/docs/cli/builds-and-versions)
- [Upload, run, and retrieve a research analysis](/docs/research/remote-cli)
- [Run and continue remote Codex tasks](/docs/research/codex-sessions)
- [Launch a private research dashboard](/docs/research/private-dashboard)

## Read documentation from the CLI

These commands read the docs bundled with the installed CLI and need no login:

~~~sh
cocalc docs list --category CLI
cocalc docs search "project secrets"
cocalc docs show projects/project-secrets
~~~

Prefer the task-specific CLI command when one exists. For ordinary automation,
start with the authentication flow appropriate to your environment rather than
creating a broad API key. The [HTTP API guide](/docs/api/http-api) covers narrow
external integrations.
`;

export const HTTP_API_BODY = String.raw`
## What the HTTP API is for

The CoCalc HTTP API is for narrow integrations that need to call CoCalc from an
external service. It is not the primary automation surface for most CoCalc-ai
workflows.

Use the [CoCalc CLI](/docs/cli/use-cocalc-cli) first when you are automating
CoCalc from a terminal, agent, local script, or development environment. The CLI
has richer typed workflows for docs, browser sessions, notebooks, project hosts,
and authenticated local development.

## API keys in CoCalc-ai

New API keys require at least one explicit capability. Choose only the
capabilities needed by the integration. Keys with \`project:read\`,
\`project:write\`, \`file:read\`, \`file:write\`, \`project:exec\`, or
\`codex:run\` also require at least one allowed project ID. Set that allowlist
to the projects the integration needs.

Treat API keys like credentials:

1. Create keys only for specific integrations.
2. Give each key a clear name and the smallest useful capability set.
3. Rotate or delete keys that are no longer needed.
4. Store keys outside source files, notebooks, chat messages, and terminal
   history.
5. For code running inside a project, store external service tokens as
   [project secrets](/docs/projects/project-secrets), not as files.

## Authentication shape

The HTTP API uses basic authentication. Put the API key in the username field
and leave the password blank.

The following command shows the authentication syntax while requesting the
\`/api/v2\` reference index. Fetching that index does not verify that a key is
valid or permitted to run an operation. Select the intended operation from the
reference and follow its documented URL, HTTP method, request fields, and
permissions.

~~~sh
curl -u "$COCALC_API_KEY:" https://cocalc.ai/api/v2
~~~

For local development, use the local site origin instead of
\`https://cocalc.ai\`.

## When to use something else

Use \`cocalc-cli\` for project, browser, docs, notebook, and host workflows when
a typed command exists. Use project secrets for credentials consumed by code
inside a project. Use Codex or browser-session docs actions when the job is to
open or verify a UI destination in the current session.

## Why this matters in CoCalc

CoCalc-ai is designed around authenticated, typed control paths instead of one
large ambient API key. That keeps the attack surface smaller while still giving
humans and agents practical ways to automate the product.
`;
