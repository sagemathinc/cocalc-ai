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

export const PUBLISH_FILES_BODY = String.raw`
## What file publishing is for

Publish project files when you want to share read-only content from a project
through an unlisted URL. A published share points at one folder, or at the
whole project HOME directory.

Use file publishing for examples, notebooks, reports, course material,
workshop folders, chat logs, and other project content that should be viewable
or copyable without making the viewer a normal collaborator.

This is different from [RootFS publishing](/docs/projects/publish-rootfs).
RootFS publishing shares a reusable software environment. File publishing
shares read-only files under \`/home/user\`.

## Publish a folder

Open the project and use one of these entry points:

1. In the file explorer, right-click a folder and choose **Publish**.
2. Select a folder, then use the file action to publish it.
3. Open **Settings** and use the **Publish** section to create or manage
   shares.

The file explorer shows a **Published** tag for paths that are already shared.
Click that tag to open the publish configuration for that path.

## Publish the whole project

The project-level **Settings -> Publish** section is the easiest place to
publish the whole project. Whole-project publishing means publishing
\`/home/user\`, not the operating system, project host, secrets, snapshots, or
backups.

Whole-project shares automatically exclude private and internal paths such as
\`.ssh\`, \`.cache\`, \`.local\`, \`.snapshots\`, and \`.backups\`. You also
cannot publish \`.snapshots\` or \`.backups\` directly.

Publishing is only allowed for paths inside \`/home/user\`. Project secrets are
mounted outside HOME under \`/run/secrets/cocalc\`, so they are not project
files and are not included in public shares.

## Share URLs and slugs

Each published item has a URL of the form:

~~~text
/share/<slug>
~~~

CoCalc creates an unguessable short slug by default. You can change the slug to
something easier to remember if the link is meant to be public or easy to type.
Slugs are global, URL-safe names; if a slug is already in use, choose another.

Shares are unlisted. CoCalc does not publish a directory of public shares, but
anyone who receives the URL may be able to open it. Treat the URL as a sharing
link, not as a private secret.

## Viewer access model

A viewer who opens a share must be signed in. Opening the share grants that
account temporary read-only viewer access scoped to the published path.

The project host enforces the read policy on the backend. The UI hides editing,
terminal, agent, and other write or execution features in viewer mode, but the
backend policy is the security boundary. A path-restricted viewer must not be
able to list, fetch, or copy files outside the published path.

Multiple shares can exist in the same project. Each share has its own path,
slug, enabled state, and viewer grant behavior.

## Read-only viewing and copying

Published files open in CoCalc's normal read-only viewers where possible:
notebooks render as notebooks, markdown renders as markdown, text files use the
editor viewer, and chat files use a read-only chat view.

Viewers can copy selected files or folders to a project they own or create a
new project and copy the selected content there. Copying uses the same
path-restricted policy as viewing. Whole-project copies exclude private and
internal paths.

When the source and destination projects can be placed on the same host, copies
are usually fast. Cross-host or cross-bay copies can take longer, and CoCalc
shows progress while the copy is running.

## Disable or unpublish

Disable a share when the content should no longer be reachable through its
public URL. Temporary viewer access is revoked after the disabled state
propagates. Already-open viewers may keep access for up to about one minute
while short authorization caches expire.

Disabling a share does not recall content that a viewer already saw, downloaded,
or copied into another project. If you accidentally publish secrets or malicious
content, disable the share immediately and rotate any exposed credentials.

## Archived projects

Public shares are not available while the source project is archived. Restore
or restart the project before expecting published links to work again.

## Manage all shares

Use **Project Settings -> Publish** to manage shares in the current project,
including whole-project publishing.

Use **Account Settings -> Public Shares** to review public shares across
projects you can manage, open their URLs, copy links, jump to the project path,
and disable shares. Destructive bulk actions require fresh authentication and a
clear confirmation.
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

## RootFS recipes

RootFS recipes are a build-time authoring layer for recreating images across
CoCalc sites. They are inspired by devcontainer features and GitHub Actions:
a recipe has steps, each step can use a local module such as \`cocalc/apt\`,
\`cocalc/julia\`, or \`cocalc/pluto\`, and modules can contribute RootFS catalog
metadata such as tags, theme, content actions, and app launchers.
The CLI supports YAML and JSON recipe files; YAML is the recommended authoring
format.

Recipes are not the live source of truth for a published RootFS entry. The
published catalog metadata remains authoritative. Recipes are for authors,
admins, and agents who need to rebuild or adapt an image.

Explain a recipe without running it. You can pass a file path or the name of a
bundled example recipe:

~~~sh
cocalc rootfs recipe ls
cocalc rootfs recipe explain src/packages/rootfs-recipes/examples/julia-pluto.yaml
cocalc rootfs recipe explain julia-pluto
~~~

Recipe modules such as \`cocalc/jupyter-python\` are composable steps, not full
published builds. The CLI can still explain a module by treating it as a
one-step recipe:

~~~sh
cocalc rootfs recipe explain cocalc/jupyter-python
cocalc rootfs recipe explain jupyter-python
~~~

Run a recipe in a clean builder project:

~~~sh
cocalc rootfs recipe run julia-pluto
~~~

Recipe steps stream command output while they run. Each step defaults to a
900-second command timeout; use \`--step-timeout <seconds>\` for larger builds
such as SageMath, CUDA stacks, or source builds:

~~~sh
cocalc rootfs recipe run cocalc-base --step-timeout 1800
~~~

Run and publish the result:

~~~sh
cocalc rootfs recipe run julia-pluto \
  --publish \
  --switch-project \
  --wait
~~~

Pass \`--project <project_id>\` to run in an existing project instead of creating
a clean builder project. Pass \`--config-out rootfs-config.json\` to save the
generated portable RootFS config JSON for inspection or reuse.

From inside a running CoCalc project, pass \`--here\` to apply a recipe directly
to that project using local subprocesses instead of remote project-host exec:

~~~sh
cocalc rootfs recipe run cocalc/r --here
~~~

This is useful when a recipe is acting as a reusable software installer rather
than as a clean image build. The command writes portable RootFS publish metadata
into \`/home/user/.cocalc/rootfs-recipes/*.rootfs-config.json\` by default; the
Runtime Image publish dialog can import that JSON directly from a project file.

The repository also includes a minimal CoCalc site base recipe with basic shell
tools, LaTeX, Python, JupyterLab, scientific Python packages, uv, SFTP support,
and both Python and bash Jupyter kernels:

~~~sh
cocalc rootfs recipe explain cocalc-base
~~~

GPU machine learning recipes are also included. They build on the same
Jupyter/uv base and install NVIDIA GPU-enabled Python packages:

~~~sh
cocalc rootfs recipe explain ml-pytorch-gpu
cocalc rootfs recipe explain ml-tensorflow-gpu
~~~

The PyTorch recipe uses the official CUDA wheel index, defaulting to CUDA 12.8.
The TensorFlow recipe installs \`tensorflow[and-cuda]\` and applies the
recommended virtual-environment symlink fix for NVIDIA libraries. Both recipes
can be verified on a non-GPU builder by checking that the GPU-enabled packages
are installed; set the module input \`require_gpu: true\` when the builder
project must also prove that an NVIDIA GPU is visible.

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
