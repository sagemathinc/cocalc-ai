/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const COCALC_CLI_BODY = String.raw`
## What the CoCalc CLI is for

The CoCalc CLI is the preferred automation interface for many CoCalc-ai tasks.
It can work with the running site, project context, browser sessions, notebooks,
docs, hosts, and other typed workflows without exposing a broad API key.

Use the CLI when you want to automate CoCalc itself. Use project terminals and
ordinary command-line tools when you want to automate software inside a project.

## Why not start with API keys

CoCalc-ai intentionally reduced the power of general API keys. Broad API keys
were rarely used and increased the security and attack surface risk. Prefer
task-specific CLI commands and authenticated browser-session or project
commands when they exist.

API access still has a place for narrow integration points, but it should not be
the default answer for normal project, notebook, docs, or browser automation.

## Common CLI workflows

Search and show the versioned docs bundled with this CoCalc-ai version:

~~~sh
cocalc docs search "project secrets"
cocalc docs show projects/project-secrets
~~~

Open a documented UI destination in the current browser session:

~~~sh
cocalc browser action docs-list
cocalc browser action docs settings.environment.secrets
cocalc browser action docs hosts.access.open --host-id "$COCALC_DOCS_VERIFY_HOST_ID"
~~~

Work with live notebooks using the project Jupyter commands instead of editing
\`.ipynb\` JSON directly:

~~~sh
cocalc project jupyter -h
~~~

For local development against a running hub, load the matching environment
before control-plane or browser commands:

~~~sh
cd src
eval "$(pnpm -s dev:hub:env)"
~~~

## Why this matters in CoCalc

The CLI gives humans and agents a stable, inspectable way to drive CoCalc-ai
without scraping the UI or handing out overly powerful credentials. It is also a
bridge between docs, browser-session actions, notebooks, and project-host
administration.
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

CoCalc-ai intentionally reduced the capabilities of broad API keys. Very few
users relied on the old broad API-key surface, and keeping it large creates
security risk. New API keys should be scoped to the minimum capability needed
for the integration.

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
