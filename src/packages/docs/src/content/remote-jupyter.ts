/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const REMOTE_JUPYTER_KERNELS_BODY = String.raw`
## Your notebook in CoCalc, your computation elsewhere

This guide describes remote kernels in **CoCalc AI**. A remote kernel lets a
CoCalc notebook run code on another computer over SSH.
Choose it from the kernel list and work with cells, plots, and results as usual.
The notebook stays in your CoCalc project; the language process runs on the
remote machine. You do not need a remote CoCalc installation or Jupyter web server.

Use a dedicated VM, an institution's server, or rented GPU compute that you can
access from your project. This is especially useful when the remote machine
already has your datasets, software, or GPU. You can register kernels from
several machines and select the appropriate one for each notebook.

## Important: there is no automatic file sync

**The notebook and the remote machine have separate filesystems.** Connecting a
remote kernel does not copy or synchronize files in either direction.

| What you work with | Where it lives |
| --- | --- |
| Notebook cells, Markdown, and captured notebook outputs | The notebook in your CoCalc project |
| A dataset opened by code in a remote kernel | The remote machine |
| Files written by that code, such as CSV files, models, or saved images | The remote machine |
| Files opened in the CoCalc file browser or project terminal | Your CoCalc project |

For example, a plot displayed in a cell can be saved as notebook output in
CoCalc. A PNG written by that same cell to disk is on the remote machine, not
automatically in your CoCalc file browser. Uploading a dataset to the project
does not make it available to the remote kernel.

Keeping data where it already lives avoids potentially slow and confusing
synchronization. Transfer files separately when needed, using tools such as
SCP or rsync, and manage remote storage and backups independently.

## Before you connect

You need password-less SSH access **from the CoCalc project** to the remote
account. Having SSH working from your laptop is not sufficient. Authorize the
project's public key on the remote account, and optionally give the destination
an alias in the project's SSH config. Never put private keys in a notebook.

The initial tested environment is an Ubuntu 24.04 x86_64 dedicated VM. Other
SSH-accessible machines may work, but provider images and software stacks vary.
Python 3 is used for discovery and supervision even when the selected kernel
is not Python. Preparing a new environment requires outbound HTTPS and disk space.

CoCalc also needs an updated project tools bundle. If setup asks you to restart
the project, save your work and restart before trying again; this stops the
project's running processes.

## Connect a remote kernel

1. Open a notebook in your project and open the kernel selector.
2. Click **Remote kernel**.
3. Choose an SSH alias from the dropdown, or enter a destination such as
   **user@your-server**, then click **Connect**.
4. If this is a new SSH host, verify its host-key fingerprint through a trusted
   source before accepting it. A changed key requires investigation, not bypassing
   host-key checking.
5. Once connected, choose a discovered kernel or create a Python environment.
   Names are filled in automatically; **Advanced** exposes the configuration.
6. Click **Set up kernel**. After setup succeeds, run a small cell in the
   selected kernel to check it.

SSH errors are reported before kernel configuration. If access fails, check the
destination, username, authorized public key, and whether the VM is running.

## GPU Python or an existing kernel

Setup detects supported NVIDIA GPU hardware and suggests **Create GPU Python
environment (PyTorch)** when available. Selecting that option and completing
setup installs a prepared Python environment with PyTorch and its CUDA packages.
It requires working NVIDIA drivers on the VM; it does not provision a GPU or
install its host driver. GPU packages can require several GB of disk space.
An inconclusive GPU check is shown as a warning, not treated as CPU-only.

Without a GPU, you can create a regular Python environment. You can also select
an existing discovered Jupyter kernel in **any language**, including Bash or
SageJS; the feature is not restricted to Python. Install and register other
kernels on the remote machine separately.

For an installed R, Julia, or other non-Python kernel, choose its discovered
entry under **Kernel**. **Advanced > Existing Python** and **Remote Python
interpreter** are specifically for an existing Python executable; do not put an
R or Julia executable in that field. A discovered kernel uses its remote
kernelspec path instead of a Python installation recipe.

If a kernelspec is outside the usual search paths, enter its directory in
**Advanced > Additional remote kernelspec directory**, then click **Refresh
discovery** and select the discovered kernel. After **Set up kernel** succeeds,
run a small computation in the selected language and record its version,
working directory, and active package environment. Successful discovery or
registration alone does not verify those details or the packages needed by
your analysis.

For a Python kernel, check where code runs with:

~~~python
import socket
print(socket.gethostname())
~~~

For the GPU Python option, check CUDA with:

~~~python
import torch
print(torch.cuda.is_available())
if torch.cuda.is_available():
    print(torch.cuda.get_device_name())
~~~

## Collaboration, history, and agents

The notebook remains a normal collaborative CoCalc document. You retain realtime
editing, TimeTravel, and the project's configured snapshots and backups for
project files, including the saved notebook. **These do not back up files or
datasets stored only on the remote machine.**

Agents can use the selected remote kernel through the same live notebook tools
they use for local kernels. Ask an agent to use the notebook, rather than assume
commands in the project terminal run on the remote machine. See
[Use Jupyter notebooks](/docs/jupyter/use-jupyter) for live notebook workflows.

Collaborators who can run code in the project can use SSH credentials accessible
to that project. For a class, use separate student projects and remote accounts
or VMs when students should not share execution access.

## Stopping, disconnects, and costs

Interrupt and restart operate on the remote kernel. Restarting loses its
in-memory variables. Losing the browser connection is different from losing
the project's SSH connection to the VM: output produced during an SSH outage
may be lost, and execution may be uncertain. Requests are not automatically
replayed. A VM reboot loses kernel memory; restart the kernel explicitly.

Remove a registration through **Remote kernel > Registered kernels** when you
no longer need it. **Stopping a kernel or removing its registration does not
stop the VM, end its billing, or delete its remote environment.** Manage those
through your compute provider or VM controls.
`;
