/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const CHOOSE_RESEARCH_COMPUTE_BODY = `
## Choose where your code runs

Use this guide when a research task needs more RAM, CPU capacity, a GPU, or
software that does not fit your current CoCalc AI project. Start with where
the code and data should live, then choose a compatible machine you can use.
The available choices depend on your CoCalc deployment and account.

| Your need | Choose | Execution and files |
| --- | --- | --- |
| Keep using the project's notebooks, terminals, files, and services together on different compute | [Project host](/docs/hosts/project-hosts) | The host runs the CoCalc project. Moving it transfers project data through backup and restore; running processes do not move with their memory. |
| Control a conventional machine, install system services, or use a supported Windows environment | [Managed VM](/docs/projects/virtual-machines) | An account-owned machine attached to a project, with its own operating system and files. CoCalc project software is not installed automatically. |
| Use a server or GPU machine that already has your software or datasets, while editing a notebook in CoCalc | [Remote Jupyter kernel](/docs/jupyter/remote-kernels) | The notebook stays in the project, while code runs on the remote machine over SSH. Files are not automatically synchronized. |

A managed VM can also provide a remote kernel. In that combination, use the VM
controls to manage the machine and the notebook's kernel selector to choose
where notebook code runs.

## Match the machine to the workload

Write down what a small, representative run needs before increasing capacity:

- **RAM:** measure the working set of the whole job, including concurrent
  kernels or workers. For a project host, compare host RAM with the
  [per-project RAM policy](/docs/hosts/access-and-ram).
- **CPU:** check whether your program uses several cores. More cores alone
  will not make a serial program run in parallel. Compare the same input and
  result when measuring a different machine.
- **GPU:** identify the required model, device count, memory per device, and
  compatible driver and framework. Host RAM and GPU memory are separate.
  Selecting a GPU machine does not make CPU-only code use it.
- **Software and architecture:** check the selected machine's architecture
  and available operating system or image. Compiled packages and binaries
  must support that architecture; an existing environment is not proof of
  compatibility. See [Project images](/docs/projects/runtime-image) when using
  a project host.
- **Storage and location:** include inputs, temporary files, environments, and
  saved results. Consider where datasets and backups already reside. Host
  storage, project quota, VM disks, and remote files are different resources;
  see [Project host storage](/docs/hosts/storage) and the VM or remote-kernel
  guide for the route you choose.

Use the current machine selector to check compatible model, architecture,
region, and machine-type combinations. A machine available in one location
may not be offered in another. Moving a project across regions can also change
its backup region; review [Moving projects](/docs/hosts/move-projects) first.

## Check availability, permission, and readiness separately

These checks answer different questions:

| Check | What it tells you | What to do next |
| --- | --- | --- |
| Catalog and compatibility | The configured provider offers that machine configuration in the selected location. | Confirm the exact machine, GPU count, architecture, and image in the selector. |
| Provider capacity and quota | Whether the provider reports capacity and an applicable allocation limit. | Where capacity advice is shown, check its region, Standard or Spot mode, timestamp, and quota. Unknown or stale advice is not confirmed availability; selection does not reserve capacity. |
| Host access or account eligibility | Whether you may place a project or create/start managed compute. | Read the displayed reason. Host delegation, shared-pool membership, account authentication, two-factor authentication, and funding requirements are separate from provider capacity. |
| Runtime readiness | Whether the selected machine and the software needed for your job are ready. | Wait for host bootstrap or VM startup, then test the intended project, terminal, or notebook kernel. A queued operation is not a ready runtime. |

Being a project collaborator does not automatically give you permission to
place other projects on its host or administer the host. Use
[Host access and RAM](/docs/hosts/access-and-ram) for delegated roles and
shared-pool access. After signing in, check your
[account settings](/docs/account/settings),
[two-factor authentication](/docs/account/two-factor-authentication), and the
funding explanation shown by the host or VM controls. Current requirements
and limits are account-specific.

Review the displayed running and stopped costs before creating compute. Spot
capacity can be interrupted or unavailable. Use
[Host spot recovery](/docs/hosts/spot-recovery) or the
[VM lifecycle and costs guide](/docs/projects/virtual-machines) for the
applicable recovery and storage behavior.

## Inspect choices from the CLI

Install the [CoCalc CLI](/docs/cli/getting-started) and select an
[account profile for the intended site](/docs/cli/authentication-and-targets).
The following commands inspect existing resources and catalogs:

~~~sh
cocalc host list
cocalc host catalog --provider gcp
cocalc vm catalog --provider gcp
~~~

The host list shows hosts visible to the account. The two catalog commands
describe different resources: project hosts and managed VMs. The VM catalog
requires account authentication. GCP is the example provider here; select a
provider supported by your site and command. An empty list or an access error
should prompt an account/site and permission check before choosing a machine.

For a host you can access, replace HOST_ID with its ID or name:

~~~sh
cocalc host get HOST_ID
cocalc host bootstrap-status HOST_ID
~~~

Inspect the host status and desired versus installed bootstrap state. If
startup is incomplete, use [Host logs](/docs/hosts/logs) to investigate before
retrying an operation. Check the current state after a timeout so you do not
mistake an unfinished operation for a failed one.

The list and GCP catalog commands above were checked with CoCalc CLI 1.0.3
against CoCalc.ai on 2026-09-11 with JSON output enabled. Results included
an empty accessible-host list. The two commands requiring HOST_ID were checked
against command help; an existing accessible host is needed to exercise them.

## Continue with the route you chose

- **Project host:** choose a host with suitable resources and placement
  access. Follow [Use project hosts](/docs/hosts/project-hosts). For an existing
  project, save results and checkpoints to files, review
  [move behavior](/docs/hosts/move-projects), and check
  [which host changes require a restart or deprovision](/docs/hosts/change-rules).
- **Managed VM:** follow [Virtual machines](/docs/projects/virtual-machines)
  to review the configuration, connect, and transfer inputs. Manage the VM's
  files and retained storage separately from project files.
- **Remote kernel:** follow [Remote Jupyter kernels](/docs/jupyter/remote-kernels).
  Confirm password-less SSH works from the CoCalc project to the remote
  account, and put inputs on the filesystem that the remote code will read.

After setup, run a small test in the intended terminal or kernel. Confirm the
software, available devices, input paths, and saved result before starting the
full computation. Record the machine and environment alongside the result so
you can compare later runs. Stopping a notebook kernel does not stop a separate
VM or project host; use that resource's lifecycle controls when it is no longer
needed.
`;
