/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PROJECT_SECRETS_BODY = String.raw`
## What project secrets are for

Project secrets are named values that are available to code running in a
project without committing private tokens into notebooks, scripts, terminals,
or TimeTravel history.

Use them for API keys, access tokens, deployment credentials, and other values
that code needs at runtime but should not be stored in project files.

Secrets are encrypted at rest in the database and mounted into running projects
as read-only files under \`/run/secrets/cocalc/<name>\`. They are not stored in
project files, snapshots, backups, rootfs images, downloads, or public shares.

## Add a secret from the UI

1. Open the project.
2. Open **Settings**.
3. Go to **Environment**.
4. Choose **Secrets**.
5. Add a name and value, then save it.

The exact UI action is identified as \`settings.environment.secrets\`. The docs
system will use these action ids so Codex and other agents can open the right
panel in the current browser session instead of merely describing where to
click.

## Use the secret

Secrets are files, not environment variables. In a terminal, notebook, or
script, read the value from the mounted secret file. Use the
\`COCALC_SECRETS\` environment variable instead of hardcoding the directory.

~~~python
import os
from pathlib import Path

secrets_dir = Path(os.environ["COCALC_SECRETS"])
token = (secrets_dir / "MY_API_TOKEN").read_text().strip()
~~~

Use clear uppercase names such as \`OPENAI_API_KEY\`, \`HF_TOKEN\`, or
\`DATABASE_URL\`. Any code or collaborator with access to the running project
can read these files, so avoid putting secret values in source files, notebook
outputs, chat messages, logs, or command history.

SSH private keys usually need a final newline. If you paste one manually, use
the warning in the Secrets dialog to add the newline before saving.

## Why this matters in CoCalc

CoCalc projects are collaborative, durable, and agent-friendly. That is exactly
why secrets should have a first-class home: humans and agents can run code,
restart terminals, execute notebooks, and automate tasks without turning private
credentials into shared document content.
`;

export const CREATE_PROJECT_BODY = String.raw`
## What projects are for

A CoCalc project is a persistent Linux workspace with files, terminals,
notebooks, chat, settings, collaborators, secrets, and an optional project host.
Use one project for a class assignment, research computation, agent sandbox,
paper, workshop, or team workspace.

## Create a project

1. Open **Projects**.
2. Choose **New Project**.
3. Give the project a clear name.
4. Pick an initial setup if one is offered.
5. Open the project and add files, collaborators, or runtime settings.

Project names are for humans. The project id is the durable identifier used by
APIs, agents, browser-session actions, project hosts, and logs.

## Choose the right boundary

Create separate projects when work needs different collaborators, secrets,
software environments, compute resources, or retention policies. Keep related
files in the same project when they share one runtime environment and should be
reviewed together.

## Why this matters in CoCalc

Most CoCalc features are project-scoped. Once a project exists, humans and
agents have a shared place to run commands, edit notebooks, manage secrets,
configure the runtime image, and keep long-running work attached to durable
backend state.
`;

export const PROJECT_LIST_BODY = String.raw`
## What the projects page is for

The projects page lists the CoCalc projects you can access. Use it to open
recent work, create projects, search by title or file, inspect activity, and
manage the projects that back your courses, research, classes, and agent
workspaces.

## Organize projects

Use clear project names and descriptions. Archive, stop, or delete work that is
no longer active, and keep important projects easy to find with naming
conventions that match your team or course.

## Create new projects

Create a project when you need a separate filesystem, collaborator set, runtime
environment, or host placement. For the short creation flow, see
[Create a project](/docs/projects/create-project).
`;

export const PUBLISH_ROOTFS_BODY = String.raw`
## What RootFS publishing is for

A RootFS image packages the Linux software environment for a project. Publishing
a RootFS catalog entry makes that environment discoverable and reusable by other
projects, courses, workshops, and agents.

Use RootFS publishing when you want to share all of these together:

- a well-defined runtime image,
- metadata that explains when to use it,
- a public landing page that can create a project from it,
- optional discovery actions such as browse, open, copy, external links, and app
  launchers.

The catalog metadata is the source of truth. Portable JSON export/import is for
moving metadata between projects or authoring it with an agent; it is not a
second live manifest inside the image.

## Publish from a project

1. Open the project that has the software installed and tested.
2. Open **Settings**.
3. Go to **Environment**.
4. Open **Runtime Image**.
5. Choose **Publish Current RootFS** or manage the current catalog entry.
6. Fill in metadata, theme, discovery actions, and visibility.
7. Save or publish.

Publishing the current project RootFS snapshots the visible software
environment. It does not publish \`/home/user\`, \`/root\`, or \`/tmp\`.
Files that users should copy or inspect should live in a stable non-HOME path
such as \`/opt/<name>/examples\`.

## Slugs and public landing pages

Every catalog entry gets a short public slug. The share URL is:

~~~text
/rootfs/<slug>
~~~

The image-id fallback is:

~~~text
/rootfs/id/<image_id>
~~~

Use the slug field in RootFS catalog management if you want a human-readable
link such as \`/rootfs/pluto-julia-smoke\`. Leave it blank when you are fine
with an automatically generated slug. Slugs are globally unique, URL-safe, and
can contain lowercase letters, numbers, and hyphens.

The landing page should render from catalog metadata alone. Users can review the
image, create a project using the image, and then see the same RootFS actions in
the new project.

## Discovery actions

Discovery actions explain what users can do after selecting a RootFS image.
They appear in the public landing page and in the project RootFS panel.

Supported action types are:

- **External link**: link to documentation or project websites.
- **Browse**: open a directory inside the RootFS.
- **Open**: open a specific file inside the RootFS.
- **Copy to HOME**: copy examples or starter files into \`/home/user\` so edits
  persist if the runtime image changes.
- **Project app**: restore a managed project app spec and launch it.

Prefer actions that do not depend on files already in HOME. If an app needs
example files, put those examples in the RootFS and add a copy action for users
who want editable copies.

## App launchers

An app action stores a normalized app spec in the RootFS catalog metadata. The
recommended workflow is:

1. Configure the app in the publishing project.
2. Test that it starts and opens correctly.
3. Add that configured app to the RootFS discovery actions.
4. Publish or update the catalog entry.

When a user launches the action in another project, CoCalc creates or updates
the app spec in that project, starts it, waits for readiness, and opens it.

Do not store only a template id in RootFS metadata. Store the full app spec so
the RootFS catalog entry is self-contained and can be restored by humans,
agents, and CLI automation.

## CLI and agent workflow

Export a config JSON from the RootFS management UI when you want an editable,
portable copy of the metadata. Agents can also author the same shape directly.

Save metadata for an existing runtime image:

~~~sh
cocalc rootfs save \
  --image cocalc.local/rootfs/<digest> \
  --config-file rootfs-config.json \
  --slug my-rootfs
~~~

Publish the current project RootFS:

~~~sh
cocalc rootfs publish \
  --project <project_id> \
  --config-file rootfs-config.json \
  --slug my-rootfs \
  --switch-project \
  --wait
~~~

CLI flags override values in the config file. This is useful when an agent
starts with a reusable config and then sets the label, slug, visibility, or
version for a specific publication.

## Test checklist

After publishing, test the full user path:

1. Open the public landing page at \`/rootfs/<slug>\`.
2. Create a project from that page.
3. Confirm the new project records the expected RootFS image id.
4. Open the project RootFS panel.
5. Test browse, open, copy, external link, and app actions.
6. If the RootFS includes app actions, verify the app reaches ready state and
   opens through the project proxy URL.

For app-heavy images, also test from a fresh project so stale app specs, cached
processes, and files in HOME do not hide missing RootFS dependencies.

## Related docs

- [Runtime images and RootFS](/docs/projects/runtime-image)
- [Create a project](/docs/projects/create-project)
`;
