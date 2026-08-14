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

export const VIRTUAL_MACHINES_BODY = String.raw`
## What virtual machines are

Managed Compute VMs are standalone cloud machines owned by your account and
attached to a CoCalc project. Choose Linux on GCP or Nebius, including supported
ARM and GPU machines, or Windows Server 2022 on GCP. CoCalc, Jupyter, and other
CoCalc project software are not installed automatically.

Use a VM when the project runtime is not the right size or shape for a job, or
when you need full control of a conventional machine. Unlike a locked-down
CoCalc project container, a VM gives you:

- administrative access to install system packages and run system services;
- Docker and other container runtimes;
- FUSE filesystems and long-running system daemons on Linux;
- the full machine for your workload, with no CoCalc project services competing
  for its CPU or memory;
- predictable, dedicated performance that you can benchmark directly; and
- direct SSH access through a managed public address and stable DNS hostname.

That control also means you can misconfigure, exhaust, reboot, or crash the
machine. Managed Compute treats every VM independently; it does not provide
private cluster networking or a cluster scheduler.

## Create a VM

Use **Open project VMs** on this page to select a project and open its VM page,
then choose **Create VM**. The form filters the live cloud catalog so that the
selected operating system, architecture, GPU, region, and machine type are
compatible. You can sort available regions and machines by price.

The currently supported combinations are:

- **Linux:** minimal Ubuntu 24.04 LTS on GCP or Nebius. GCP includes x86-64 and
  ARM64 choices; supported Linux GPU machines are offered by both providers.
- **Windows:** Windows Server 2022 Desktop Experience on GCP, using x86-64 CPU
  machines. Windows GPU machines and detachable home volumes are not currently
  offered.

Configure the name, funding source, cloud, region, machine, and boot disk in the
main form. Expand **Advanced options** for Spot/Standard capacity, automatic
fallback, a deletion deadline, and SSH settings. Before anything is purchased,
**Create VM** shows a confirmation with the exact operating system, machine,
location, capacity, boot-disk size, home storage, and estimated price.

The persistent boot disk holds the operating system and any data not placed on
a separate home volume. It survives stop/start and automatic Spot recovery, but
it is deleted with the VM. Choose its size carefully: **boot disks cannot
currently be enlarged after creation**. The site controls the maximum allowed
size.

Spot capacity costs less but can be interrupted or unavailable. With automatic
Standard fallback enabled, CoCalc keeps trying Spot and may use Standard
capacity for up to 24 hours so the VM can recover. Use Standard directly for
work that must remain continuously available. Windows can take longer than
Linux to complete its first boot.

Creating or starting a VM requires an eligible funding lane:

- **Site-funded** is available only to site administrators.
- **Account prepaid** uses the account's available balance and membership
  limits.
- **Account postpaid** requires an eligible membership and automatic billing.

The create form starts from site defaults. Use **Manage > Create similar** on an
existing VM when you intentionally want to reuse its configuration. The
equivalent CLI command is available under **Advanced options**.

## Connect from the project

Linux and Windows both use the login name \`user\`. On Linux, the home directory
is \`/home/user\`; on Windows, the profile is \`C:\Users\user\`.

When the project SSH key is selected during creation, CoCalc maintains a block
in the project's \`~/.ssh/config\`. The VM name is the alias, so from a project
terminal the shortest connection is:

~~~sh
ssh my-vm
~~~

The **Connect** menu shows this project-local command first, followed by the
CoCalc CLI command, DNS hostname, and full direct SSH command. The same commands
work for Linux and Windows:

~~~sh
cocalc vm list
cocalc vm ssh my-vm
cocalc vm ssh my-vm uname -a
~~~

For Linux file transfer, use \`rsync\` through the CLI:

~~~sh
cocalc vm rsync ./data/ my-vm:/home/user/data/
cocalc vm rsync my-vm:/home/user/results/ ./results/
~~~

\`cocalc vm rsync\` is not supported for Windows. Use \`scp\`, SFTP, Git, or a
Windows-compatible transfer command instead.

Inside a CoCalc project, \`cocalc vm list\` defaults to that project. With an
account CLI profile, \`cocalc vm list --all\` lists every VM owned by the
account. Run \`cocalc vm catalog\` to inspect the live providers, regions,
machines, GPUs, prices, operating systems, and limits before scripting a
creation.

## Connect to Windows with Remote Desktop

Windows VMs support SSH immediately after they become ready. Remote Desktop is
kept private: TCP 3389 is **not** exposed to the Internet. Use the CoCalc CLI to
generate a fresh Windows password and print an SSH tunnel:

~~~sh
cocalc vm rdp windows-vm
~~~

Use \`--tunnel\` to run the tunnel in the foreground. If RDP credentials are
already configured, you can create the tunnel directly and point your RDP
client at \`localhost:3389\`:

~~~sh
ssh -N -L 3389:localhost:3389 user@<vm-hostname>
~~~

Generating or resetting the Windows password requires fresh account approval.
The password is returned once and is not stored in the project. Resetting it
invalidates the previous Windows password.

## Addresses and public services

Each logical VM has a random stable DNS hostname. Its public IPv4 address stays
attached across automatic Spot recovery while the desired state remains
running. Explicitly stopping the VM releases the address; starting it again
assigns an address and repoints the same hostname automatically.

TCP ports **22** and **443** are public. CoCalc manages SSH access but does not
run, authenticate, or terminate your HTTPS service. You must configure the
server and TLS certificate on port 443. Windows RDP remains private behind its
SSH tunnel.

## Costs and usage

The creation price popover itemizes compute, persistent disk, public IPv4,
Windows Server licensing when applicable, and any configured surcharge. The
monthly figure is an estimate based on continuous use, not a commitment or a
fixed invoice. The Windows Server license is charged **only while the VM is
running**; Spot discounts compute but not that license.

The **Cost & usage** row shows the running rate, funding lane, explicit egress
rate, and measured usage. Open it for the complete running and stopped price
breakdowns. GCP public Internet egress costs **$0.10/GB**; the site pays it for
site-funded VMs. Nebius currently costs **$0/GB**. Metering normally lags by
about five minutes and the UI marks delayed data rather than treating it as
current.

Compute and the Windows license stop accruing when a VM is stopped. The
persistent boot disk and any independent home volume remain billable. Running
VMs stop when funding is unavailable, and site retention policy may eventually
delete an unfunded VM and its boot disk.

## Persistent Linux home volumes

An optional Linux home volume is independent of the VM and mounts directly at
\`/home/user\`. It survives VM deletion, can grow but cannot shrink, and can be
attached read-write to only one VM at a time. The volume and VM must use the
same provider location. Select an existing volume or create one during VM
creation; changing attachments later is not yet supported.

Nebius storage uses provider allocation increments. The UI normalizes and
prices the actual size that will be purchased before confirmation. Deleting a
detached volume is permanent and destroys all data on it.

## Operate an existing VM

The VM table shows operating system, provider, architecture, machine type, GPU,
location, boot-disk size, capacity type, price, funding, egress, expiration, and
current lifecycle state. Use:

- **Connect** for project SSH, CLI SSH, DNS, direct SSH, and Windows RDP;
- **Start/Stop** to control compute without deleting the persistent disk;
- **Manage > Change machine type** after stopping a VM;
- **Manage > Set deletion deadline** to add, change, or clear automatic
  deletion;
- **Manage > Create similar** to start a new form from that VM's configuration;
- **Manage > Change funding** to move between eligible funding lanes; and
- **Manage > Delete VM** to delete the VM, boot disk, public address, and DNS
  record.

Deletion does not normally delete an attached home volume. Verify important
results elsewhere and delete unused detached volumes explicitly so they do not
continue accruing storage charges.

## Agents and account approval

Human CLI mutations use account authentication and require fresh browser
approval for sensitive or billable actions. A Codex turn in a project does not
receive a reusable account session. Instead, it can request a narrow temporary
capability for an exact VM operation, provider, machine class, funding lane,
TTL, and spend envelope. The VM page shows the request for approval; grants are
bound to the project and turn, expire within 30 minutes, can be revoked, and are
audited.

This lets an approved agent create, start, stop, resize home volumes, or delete
managed resources without placing account cookies, cloud credentials, or broad
billing authority in the collaborative project.
`;

export const RSTUDIO_PROJECT_BODY = String.raw`
## What this page is for

Use this page when you want an RStudio Server workspace on CoCalc AI. The
workflow assumes the hosted CoCalc AI site has a published project image that
includes RStudio and Jupyter.

For generic runtime-image setup, see [Project images](/docs/projects/runtime-image).

## Create the project

1. Open the **Projects** page.
2. Choose **Create Project**.
3. Give the project a clear name, such as \`R project\` or the name of the
   analysis.
4. Select the **RStudio and Jupyter** software image.
5. Create and open the project.
6. Wait for the project runtime to start.
7. Launch **RStudio Server** from the project app/runtime controls.

The selected software image controls the starting runtime. It can include
RStudio, Jupyter, terminals, LaTeX, and libraries for the work the project
needs.

## Keep the work together

Project files stay together: R scripts, notebooks, data, rendered output, and
notes all live in one collaborative workspace. Add collaborators only when they
should share access to the same files, terminals, notebooks, and app sessions.

## Install more packages when needed

Install R packages from RStudio or an R shell:

~~~r
install.packages("tidyverse")
~~~

Install system libraries from a project terminal when needed:

~~~bash
sudo apt-get update
sudo apt-get install -y libcurl4-openssl-dev
~~~

Runtime changes are project-specific unless they are baked into a reusable
project image. If the same environment should be reused by other projects, use
the project image publishing workflow instead of repeating manual setup.
`;

export const PUBLISH_FILES_BODY = String.raw`
## What file publishing is for

Publish project files when you want to share read-only content from a project
through an unlisted URL. A published share can point at one exact file, one
folder, or the whole project HOME directory.

Use file publishing for examples, notebooks, reports, course material,
workshop folders, chat logs, and other project content that should be viewable
or copyable without making the viewer a normal collaborator.

This is different from [RootFS publishing](/docs/projects/publish-rootfs).
RootFS publishing shares a reusable software environment. File publishing
shares read-only files under \`/home/user\`.

## Publish a file or folder

Open the project and use one of these entry points:

1. Right-click a file or folder in the full-page or flyout file listing and
   choose **Publish**, or select it and use **Actions -> Publish**.
2. While editing or viewing an individual file, open the **File** menu and
   choose **Publish File**.
3. Open **Settings** and use the **Publish** section to create or manage
   shares.

The file explorer shows a **Published** tag for paths that are already shared.
Click that tag to open the publish configuration for that path.

An exact-file share exposes only that file. It does not allow viewers to list
the containing folder or read sibling files. A folder share exposes that folder
and its descendants, but nothing above or beside it.

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

Copying an exact-file share preserves its filename. Copying a folder share
creates a folder named after the share slug, copies the shared contents into
it, and opens the destination project inside that new folder.

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

Legacy publications retained from cocalc.com appear under **Account Settings
-> Public Shares** for accounts linked through legacy migration. They become
available only after a collaborator explicitly restores the corresponding
project. Historically disabled publications and unsupported legacy proxy URLs
are not migrated.

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
