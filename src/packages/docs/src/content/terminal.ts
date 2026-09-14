/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const OPEN_TERMINAL_BODY = String.raw`
## What CoCalc terminals are for

CoCalc terminals run shell processes on the backend and use xterm.js in the
browser. Hosted CoCalc projects use Linux; local CoCalc installations use the
host operating system's shell, including PowerShell on Windows.

You can reconnect to the same terminal while the project runtime remains
running. A project stop, restart, failure, or browser-idle timeout ends running
processes. Save important results in files and plan how to resume long jobs.

## Open a terminal

1. Open the project.
2. Open the file browser or the activity bar.
3. Choose **Terminal** or create a file ending in \`.term\`.
4. Run normal shell commands.

Terminal files are intentionally path-based. Opening \`work/analysis.term\`
starts in \`work/\`, and the terminal session has a stable file anchor that
humans and agents can refer to.

## Agent and CLI access

Codex can inspect and drive live terminal sessions through the browser-session
API. For persistent terminal work from an agent, prefer the typed terminal APIs
over screenshot automation when possible.

## Why this matters in CoCalc

A CoCalc terminal is collaborative, durable, and attached to project files. It is
not just a temporary browser shell: it is part of a shared computational
workspace with side chat, project storage, TimeTravel-friendly files, and direct
SSH access when you want native tools.
`;

export const USE_TERMINAL_BODY = String.raw`
## What CoCalc terminals are for

CoCalc terminals are shell sessions inside a project. Hosted CoCalc projects
use Linux; local CoCalc installations use the host operating system's shell,
including PowerShell on Windows. The terminal UI runs in the browser, while
the shell process runs in the project backend. Commands can continue through a
browser disconnect while that backend runtime remains running.

Use terminals to install packages, run scripts, inspect files, start services,
use Git, manage virtual environments, and work with command-line tools that are
part of the project environment.

## Open and organize terminals

Open a terminal from the project activity bar, the file browser, or by opening a
file ending in \`.term\`. For the short action flow, see
[Open a terminal](/docs/projects/open-terminal).

Terminal files are path-based. A terminal at \`analysis/run.term\` starts in the
\`analysis/\` directory and gives the session a stable project-file anchor.
Create separate terminal files for separate tasks when that makes the workspace
easier to understand.

## Open project files from the terminal

Use the \`open\` command to open files and directories in CoCalc from the shell,
similar to \`xdg-open\` on Linux or \`open\` on macOS:

~~~sh
open path/to/file.ipynb path/to/script.py path/to/folder
~~~

This is often faster than switching to the file browser when you are already
working in a terminal. Paths are interpreted relative to the terminal's current
directory.

## Persistent work

Collaborators can reconnect to a terminal while its project runtime is still
running. A browser-idle policy can stop the project even while a command is
running. Project stops, restarts, and failures also end running processes.

Tools such as \`tmux\` help with shell reconnection, but they do not keep a
project runtime alive through a stop or restart. Use log files, checkpoints,
and scripts so progress is visible and work can resume.

## Collaboration and safety

Terminals are collaborative. People with access to the running project can see
terminal content and may be able to interact with the shell. Avoid pasting
secrets into commands, prompts, logs, or shell history. On hosted CoCalc AI,
use project secrets for credentials consumed by project code; find **Project
secrets** in the site's [Docs index](/docs). Local CoCalc Plus uses the credentials
you configure in your local environment.

## Agents and automation

Agents should prefer typed CoCalc terminal or browser-session APIs when they
need to inspect or drive a live terminal. Use the terminal for real shell work,
but avoid relying on screenshot-only automation when a CLI or project API can
perform the same operation directly.

## Troubleshooting

If a terminal seems unresponsive, check whether the project is running and
whether a command is still active. Use Ctrl-C for a foreground command, open a
new terminal for independent diagnosis, and inspect project memory if commands
are being killed.
`;

export const GRAPHICAL_APPLICATIONS_BODY = String.raw`
## Run Linux graphical applications in CoCalc

These instructions require a Linux project with the graphical support tools.
Automatic dependency installation uses Ubuntu/Debian package tools and requires
permitted sudo access. Local CoCalc Plus uses the host operating system; it does
not turn a native macOS or Windows installation into a Linux project.

Open or create a file ending in \`.x11\` to start the graphical applications
workspace. CoCalc uses [Blit](https://blit.sh/) to provide a terminal and a
headless Wayland compositor inside the project. Applications that use Wayland
connect directly; X11 applications connect through Xwayland.

The application and its files still run in your project. Blit sends the
application windows to your browser and sends keyboard, pointer, and clipboard
input back to the project.

## One shared session per project

All \`.x11\` files in a project connect to the same graphical session. The file
name is an access point, not the name of an independent desktop. Opening
\`a.x11\` and \`experiment.x11\` therefore shows the same terminals, application
windows, and previews.

Multiple collaborators and multiple browsers can open \`.x11\` files at the same
time. They all see and can control the shared session, including the same
terminal input, pointer, clipboard, and application windows. Coordinate with
collaborators before typing into or closing a window that somebody else may be
using.

This project-wide model keeps graphical applications easy to find and avoids
running several hidden compositors and display servers in one project.

## Start an application

Use either of these methods:

- Click an application button in the toolbar. If the application is missing,
  CoCalc offers to install it in the project before launching it.
- Type a graphical command, such as \`xclock\`, \`gimp\`, or \`inkscape\`, in
  the terminal shown in the middle of the workspace.

The embedded terminal already has the Wayland and X11 environment variables
for this graphical session. You do not need to set \`DISPLAY\` there.

The **X11** RootFS includes every launcher application, Python and Jupyter,
IDLE, Tkinter, pygame, application audio, and basic LaTeX for TeXstudio. Other
RootFS images can install the graphical prerequisites and individual launcher
applications on demand.

Chromium needs additional flags in a project container. The Chromium launcher
adds them automatically. To start it from the embedded terminal, run:

~~~sh
chromium --ozone-platform=wayland --no-sandbox --disable-gpu
~~~

The \`--no-sandbox\` flag is necessary because project containers prohibit the
nested namespaces used by Chromium's Linux sandbox. This removes Chromium's
renderer-level security boundary: a compromised web page could access files
and processes available to your project user. Only open sites you trust. The
project container remains isolated from other projects and the project host.

## Play application audio

Blit sends application audio to the browser through a private PipeWire sound
server inside the project. Applications launched from the embedded terminal or
from a launcher button inherit the required PulseAudio and PipeWire settings.
This works with applications such as Chromium and pygame without access to an
audio device on the project host.

Browser autoplay rules require sound to start muted. Click the musical-note
control in Blit's status bar and enable **Desktop sound** to hear it. The control
also lets you mute the session again and select an output device when the
browser supports output selection.

For example, after installing pygame in the project, run this in the embedded
graphical terminal:

~~~sh
python3 -m pygame.examples.aliens
~~~

If graphical support was installed or upgraded while a session was running,
CoCalc restarts the shared graphical session so the new audio service is
available. This closes applications from the old session.

## Select an application window

Each application window first appears as a small surface preview in the column
on the right. Click its preview to show that window at full size in the middle
of the workspace. Click another preview to switch windows.

Closing a preview closes that application window. An application can have
several previews when it opens several windows.

## Shut down the graphical session

Choose **Shut down** at the right side of the launcher toolbar when you are
finished. Confirming stops the Blit server and closes every graphical terminal
and application window in the shared project session.

Shutdown affects every open \`.x11\` file and every connected browser, not only
the current view. The stopped view offers a button to start a fresh session.

## Find popup and dialog windows

Popup windows and modal dialogs also appear as new previews in the right-hand
column. They do not automatically replace the main window in the middle.

If the main application suddenly stops responding, look for a new preview on
the right. The application may be waiting for you to answer a file chooser,
warning, confirmation, or other modal dialog. Click that preview, respond to
the dialog, and then select the main application again.

## Launch X11 applications from another terminal or notebook

The embedded graphical terminal receives \`DISPLAY\` automatically. A regular
CoCalc terminal or a Jupyter kernel does not, because it was started outside
the graphical session.

Blit normally claims display \`:20\`. In the embedded graphical terminal, run
this to confirm the actual value:

~~~sh
echo "$DISPLAY"
~~~

Blit tries the next available display if \`:20\` is already occupied. Use the
value printed above in a regular terminal. For the normal \`:20\` case:

~~~sh
export DISPLAY=:20
xclock
~~~

In a Jupyter notebook:

~~~python
import os
import subprocess

os.environ["DISPLAY"] = ":20"  # Replace this if the graphical terminal differs.
subprocess.Popen(["xclock"])
~~~

Keep the \`.x11\` workspace running while using that display. Do not set
\`DISPLAY=:20\` globally for every project process: without a running graphical
session it points applications at a display that does not exist, and a session
may occasionally use a different display number.

## Current limitations

- Graphical application support is currently available on Linux project
  environments.
- Application compatibility varies. Blit describes its graphical compositor
  as experimental even though many common Wayland and X11 applications work.
- New windows do not automatically take over the main view. Always check the
  preview column when an application appears frozen or asks you to open, save,
  confirm, or configure something.
`;

export const SSH_ACCESS_BODY = String.raw`
## SSH access on cocalc.ai

SSH gives command-line tools on your computer direct access to a CoCalc
project. You can run remote commands and use standard tools such as \`ssh\`,
\`scp\`, \`sftp\`, and \`rsync\`.

The legacy \`ssh.cocalc.com\` gateway belongs to the previous cocalc.com
architecture. Commands such as
\`ssh PROJECT_ID_WITHOUT_DASHES@ssh.cocalc.com\` do not connect to cocalc.ai
projects. Each cocalc.ai project instead receives a managed SSH route, which
the CoCalc CLI writes into your local \`~/.ssh/config\`.

## Connect from your computer

Open **Project Settings → SSH** in the target project. The panel shows commands
for the current site and project.

Install the CoCalc CLI using the [CLI quickstart](/docs/cli/getting-started),
which includes Linux/macOS and native Windows PowerShell instructions.

Configure the project, replacing the example project id:

~~~sh
cocalc --api https://cocalc.ai project ssh-config add \
  -w 00000000-0000-4000-8000-000000000000
~~~

When run in an interactive terminal, the CLI starts browser login automatically
if you have not signed in yet. Approve that login in your browser. The command
then:

1. creates or reuses \`~/.ssh/id_ed25519\`;
2. installs its public key in the target project;
3. installs the Cloudflare SSH transport helper when needed; and
4. writes a managed host entry to \`~/.ssh/config\`.

Connect using the project id as the host alias:

~~~sh
ssh 00000000-0000-4000-8000-000000000000
~~~

The key and SSH config remain usable after CLI login expires. The account
session is needed for setup, not for each SSH connection.

## Copy files

After setup, file-transfer tools use the same host alias:

~~~sh
scp ./local-file 00000000-0000-4000-8000-000000000000:~/
scp 00000000-0000-4000-8000-000000000000:~/remote-file ./
rsync -a ./local-directory/ \
  00000000-0000-4000-8000-000000000000:~/remote-directory/
~~~

\`rsync\` must be installed at both ends. If \`scp\` or \`sftp\` reports a
missing SFTP server, install \`openssh-sftp-server\` in the project image.

## Transfer individual files with SFTP

After the SSH setup above, open a local terminal in the folder containing a
small test file named \`local-file.txt\`. On Windows, use PowerShell with the
[OpenSSH client](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview),
which includes \`sftp\`. Connect using the same alias as \`ssh\`, replacing the
example project id:

~~~sh
sftp 00000000-0000-4000-8000-000000000000
~~~

OpenSSH reads the managed \`Host\` entry, including its real \`HostName\`, user,
key, and transport settings. If you configured a custom \`--alias\`, use that
alias instead. If setup used a custom \`--config\` file, pass its path to
\`sftp -F PATH_TO_CONFIG ALIAS\`.

At the \`sftp>\` prompt, enter these commands without copying the prompt itself.
Choose unused destination names: \`put\` and \`get\` can overwrite files.

~~~text
lpwd
pwd
ls
put local-file.txt sftp-upload-demo.txt
ls sftp-upload-demo.txt
get sftp-upload-demo.txt downloaded-file.txt
bye
~~~

\`lpwd\` shows the local directory; \`pwd\` and \`ls\` describe the remote
project. \`put\` reads a local file and writes its remote destination; \`get\`
reads a remote file and writes its local destination. Confirm the uploaded file
appears in the remote listing and compare the downloaded file with your original.
Use \`lcd\` to change the local directory and \`cd\` to change the remote one;
quote paths containing spaces. Type \`help\` for the installed client's commands.

A graphical SFTP client must support the route and authentication settings in
the generated SSH configuration, including \`ProxyCommand\` when present.
Entering the project-id alias in a generic hostname field alone is insufficient;
do not assume the application imports OpenSSH configuration automatically.
If a connection fails, inspect \`sftp -v ALIAS\` and the SSH troubleshooting
steps below. For a complete upload/run/download workflow through the CoCalc CLI,
see [remote analysis](/docs/research/remote-cli).

## Connect from one CoCalc project to another

Do not run \`cocalc auth login\` inside a collaborative project. That would
store a broad, long-lived account session in a filesystem shared with the
project's collaborators.

Instead:

1. Open **Project Settings → SSH** in the target project.
2. Choose **Configure project-to-project SSH**.
3. Select the source project that will initiate connections.
4. Confirm the operation with fresh authentication.
5. In a terminal in the source project, run \`ssh TARGET_PROJECT_ID\`.

CoCalc reuses \`~/.ssh/id_ed25519\` when the source already has one. Otherwise,
it creates a new deploy key and stores its private key as the encrypted
\`SSH_PRIVATE_KEY\` project secret. It authorizes only the public key on the
target and writes the route in the source project. Your CoCalc account session
is never stored in either project.

Everyone with filesystem access to the source project can use its deploy key.
Only select a source whose collaborators should receive access to the target.
To revoke access, delete the corresponding project SSH key from the target
project's SSH settings.

## Automated course setup

If a script in the project containing a \`.course\` file must connect to every
student project:

1. Open the \`.course\` file and select **Configuration**.
2. Find **SSH to course projects**.
3. Check **Allow this course project to SSH to every student project and the
   shared project**.
4. Complete the fresh-authentication prompt.

CoCalc creates one deploy key in the course project, authorizes it in every
active student project and the shared project, and writes a managed SSH entry
for each target. A deployment script can then use a project id directly:

~~~sh
ssh STUDENT_PROJECT_ID 'python3 ~/setup.py'
rsync -a ./course-environment/ STUDENT_PROJECT_ID:~/course-environment/
~~~

The CoCalc CLI is already installed inside CoCalc projects, but this course
workflow does not run \`cocalc auth login\` and does not store an instructor's
account session in the collaborative course project.

Use **Synchronize SSH access** after adding or restoring student projects, or
after a target project moves to another host or region. CoCalc also attempts to
configure newly created student and shared projects automatically. If that
attempt happens after fresh authentication has expired, project creation still
succeeds; open Course Configuration and synchronize SSH access again.

Unchecking the option removes the managed public key from all known student
projects and the shared project, and removes their managed SSH config entries.
The deploy key itself remains in the course project so it can be reused if the
option is enabled again.

Everyone with filesystem access to the course project can use this key and thus
receives full shell access to every configured target. Only enable the option
when every course project collaborator should have that access.

The course manager who enables the option owns the project-specific public-key
entries and must also synchronize or disable them. This guard prevents a second
manager from accidentally leaving the original manager's key authorized.

## Troubleshooting

- If the first connection starts a stopped project but does not immediately
  open a shell, wait a moment and run the same command again.
- Run \`ssh -v PROJECT_ID\` to see which host, key, and proxy command OpenSSH is
  using.
- Re-run \`cocalc project ssh-config add -w PROJECT_ID\` after a project moves
  to another host or region.
- Check that the private key named by \`IdentityFile\` exists and that the
  matching public key remains listed in the target project's SSH settings.
- SSH access is full shell access to the project. Treat private keys and source
  projects accordingly.
`;
