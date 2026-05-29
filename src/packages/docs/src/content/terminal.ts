/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const OPEN_TERMINAL_BODY = String.raw`
## What CoCalc terminals are for

CoCalc terminals are real terminals running in your project Linux environment.
They use xterm.js in the browser, but the process state lives on the backend:
you can start a command, close the browser tab, and come back to the same
running terminal.

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

CoCalc terminals are persistent Linux shell sessions inside a project. The
terminal UI runs in the browser, but the shell process runs in the project
backend, so commands can keep running while the browser disconnects.

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

Browser tabs are not the process boundary. Long commands can continue after the
browser disconnects, and collaborators can reconnect to the same terminal later.
For very long or fragile jobs, use standard shell tools such as \`tmux\`, log
files, or scripts so progress is visible and restartable.

## Collaboration and safety

Terminals are collaborative. People with access to the running project can see
terminal content and may be able to interact with the shell. Avoid pasting
secrets into commands, prompts, logs, or shell history. Use
[project secrets](/docs/projects/project-secrets) for credentials consumed by
project code.

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
