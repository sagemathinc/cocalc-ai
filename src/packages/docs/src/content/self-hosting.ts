/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const COCALC_STAR_BODY = String.raw`
## What CoCalc Star is

CoCalc Star is the single-VM CoCalc appliance. It is the default self-hosting
path when you have a fresh public Ubuntu VM and want a shared CoCalc instance
without manual DNS, TLS, SSH port forwarding, or cloud-provider-specific setup.

Star installs a local control plane, local Postgres, one local project host,
rootless Podman project execution, a managed Jupyter/LaTeX root filesystem, and
Caddy HTTPS.

## Quick start

On a fresh Ubuntu 24.04 VM with ports 80 and 443 open:

~~~sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh | sudo bash
~~~

The installer detects the public IPv4 address, uses https://sslip.io for DNS,
obtains a Let's Encrypt certificate through Caddy, and shows a web onboarding
page before continuing. If the onboarding URL does not open, fix the VM firewall
or cloud network rule for port 443 before continuing.

## First-run flow

1. Create a public VM.
2. Open ports 80 and 443.
3. Run the one-line installer.
4. Open the HTTPS onboarding page.
5. Confirm the VM is reachable.
6. Wait for the installer to finish.
7. Use the bootstrap URL to create the first admin account.
8. Create a project.
9. Verify Jupyter, terminals, LaTeX, chat, and agents.
10. Invite another user and collaborate.

## When to use Star

Use Star for a lab, course, GPU box, agent sandbox, or small team where the
operator owns the VM and wants collaborators using the same browser-based CoCalc
workspace.

Star is not high availability. It is the easiest way to experience a real shared
CoCalc system on your own VM.

## Product boundaries

- Use CoCalc Plus for a local single-user install.
- Use CoCalc Star for a one-command public VM appliance.
- Use CoCalc Launchpad for lower-level operator control-plane work, custom
  project-host connectivity, or deployment development.
- Use CoCalc Rocket for production multi-user or multi-bay deployments.

## Current beta target

The documented beta target is Ubuntu 24.04 or Ubuntu 26.04 on a fresh public VM
with a public IPv4 address and ports 80 and 443 open. Manual beta installs have
passed on Google Cloud, AWS, and Azure. Other cloud providers should work if
they provide a normal Ubuntu VM and let you expose ports 80 and 443.

## Agent notes

When helping someone install Star:

1. Confirm the VM is public and can expose ports 80 and 443.
2. Prefer the one-line installer unless the user needs a pinned release.
3. If the onboarding URL fails, debug cloud firewall and VM firewall before
   debugging CoCalc.
4. Do not recommend SSH port forwarding for the public VM appliance path.
5. After install, verify the first project starts and Jupyter, terminal, LaTeX,
   and invite-user flows work.
`;

export const COCALC_STAR_LOCAL_VM_BODY = String.raw`
## Why run CoCalc Star on your own computer?

If you tried CoCalc and want the same kind of browser-based workspace on your
own hardware, a local VM is a good fit. It is especially useful when you want:

- a very private CoCalc instance that stays on your laptop or desktop server,
- very low latency because the server is physically near you,
- to use a powerful laptop, workstation, or home server you already own,
- to keep working while flying or away from reliable internet, or
- to experiment with CoCalc Star without renting a cloud VM.

This setup runs CoCalc inside an Ubuntu virtual machine on your computer. You
open CoCalc from your normal browser on the host computer.

## Recommended setup: Lima

For a personal computer, the recommended CoCalc Star local VM path is Lima. Lima
runs headless Linux VMs, is scriptable, supports localhost forwarding, and does
not push you toward a graphical desktop VM.

Install Lima first. On macOS:

~~~sh
brew install lima
~~~

On Ubuntu Linux, install QEMU support first:

~~~sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends ovmf qemu-system-x86 qemu-utils
~~~

Then install Lima using Homebrew on Linux if you already use it, or download the
current Lima binary archive from https://github.com/lima-vm/lima/releases.

Then install CoCalc Star:

~~~sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star-local-lima.sh \
  | COCALC_STAR_LIMA_SHARED_DIR="$HOME/cocalc-star-scratch" bash
~~~

This creates or starts a Lima VM named cocalc-star, installs Ubuntu 24.04,
forwards CoCalc to http://localhost:8170/, installs CoCalc Star inside the
VM, and prints the local setup URL. Project sessions, terminals, chat, and
Jupyter use the same localhost origin through CoCalc's built-in project proxy.
The optional COCALC_STAR_LIMA_SHARED_DIR value is a host folder that becomes
/scratch inside projects. For example, a host file
$HOME/cocalc-star-scratch/data.csv is visible in projects as
/scratch/data.csv. The installer creates the host folder if it does not
exist. Edit the path before running the command, or remove the environment
variable if you do not want host file sharing.

After install, open http://localhost:8170/, create the first account, create
a project, and test a terminal plus a Jupyter notebook.

The general local setup is:

1. Install a VM app that can run Ubuntu 24.04.
2. Create an Ubuntu VM with enough disk and memory for your projects.
3. Forward a local port on your computer to port 80 inside the VM.
4. Open CoCalc at a localhost URL such as http://localhost:8170/.

Using localhost is better than opening the VM's private IP address directly.
Browsers treat localhost as a trusted local address, and it is easier to
bookmark and remember.

## Which VM app should I use?

Use the VM app that fits your computer and comfort level. If you do not already
have a preference, start with Lima.

- **Recommended headless option**: Lima. Good for CoCalc Star because it is a
  scriptable Linux VM runtime with localhost forwarding.
- **Mac, easiest paid desktop option**: Parallels Desktop. Good general VM support and a
  polished interface.
- **Mac, good free option**: UTM. Works well on Apple Silicon and Intel Macs,
  but networking setup can be a little more manual.
- **Windows**: VMware Workstation, VirtualBox, or Hyper-V are reasonable choices.
  WSL2 is useful for many Linux tasks, but CoCalc Star should run in a real
  Ubuntu VM.
- **Linux**: KVM/QEMU through virt-manager, libvirt, or GNOME Boxes is usually
  the natural choice.
- **Ubuntu-focused convenience**: Multipass is easy for starting Ubuntu VMs, but
  it is not the best first choice if you need simple port forwarding.

If Lima does not fit your platform or workflow, use Parallels on Mac, VirtualBox
on Windows, and KVM/QEMU on Linux as practical manual alternatives. On Mac,
choose UTM if you want a free desktop VM app.

## Customizing the Lima VM

The Lima installer accepts environment variables passed to bash at the end
of the install pipeline.

For example, to use 16 GiB RAM, 8 CPUs, and a 200 GiB disk:

~~~sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star-local-lima.sh \
  | COCALC_STAR_LIMA_MEMORY=16GiB COCALC_STAR_LIMA_CPUS=8 COCALC_STAR_LIMA_DISK=200GiB COCALC_STAR_LIMA_SHARED_DIR="$HOME/cocalc-star-scratch" bash
~~~

The default memory is host-aware. On a typical laptop it uses a reasonable
fraction of system RAM instead of Lima's small default.

The shared directory setting is initial-install only. Lima reads this setting
when the cocalc-star VM is created. If you want to change it later, delete or
rename the Lima instance and reinstall with the new path.

To reinstall the local VM while keeping the host shared folder:

~~~sh
limactl stop cocalc-star
limactl delete cocalc-star
~~~

Do not delete $HOME/cocalc-star-scratch unless you also want to remove the host
files that were visible as /scratch.

## Networking choice

Pick one of these access patterns:

1. **Best**: http://localhost:8170/

   Configure your VM app to forward host port 8170 to guest port 80. This gives
   you a local browser URL and avoids public internet exposure.

2. **Simple fallback**: http://vm-private-ip/

   Many VM apps show a private VM IP address, such as 192.168.x.y or 10.x.y.z.
   You can often open that directly from your host browser. This
   is simple, but it is less polished than a localhost URL.

3. **Avoid for local-only VMs**: public HTTPS with https://sslip.io

   The public CoCalc Star installer can set up automatic HTTPS for a public VM.
   That is the right path for cloud servers, not for a VM that only exists on
   your laptop.

## What to expect

A local VM install is private to your machine unless you deliberately expose it
to your network. You can use it without depending on CoCalc's hosted service.
If you are offline, local project tools keep working, but internet-dependent
features still need internet access.

The default project image includes Python, pip, uv, Jupyter, LaTeX, and common
scientific Python packages. You can use pip install or uv pip install
from a project terminal for additional packages such as PyTorch.

You are responsible for the VM's disk, backups, operating-system updates, and
any data you store there. If the VM is important, back it up like any other
important local computer.

## Practical notes

- Give the VM enough disk. Start with at least 80 GB if you will use notebooks,
  LaTeX, packages, or large datasets.
- Give the VM enough memory. 8 GB is a small test VM; 16 GB or more is more
  comfortable.
- Use Ubuntu 24.04 unless the Star release notes say a newer Ubuntu version is
  supported.
- Prefer a localhost port forward over SSH port forwarding. SSH forwarding works
  for experts, but it is not the cleanest everyday setup.
- Do not expose the VM to your LAN or the public internet unless you understand
  the security implications.
`;

export const REVERSE_SSH_ACCESS_BODY = String.raw`
## What this is

Sometimes a CoCalc project needs temporary access to a computer that is not
publicly reachable. For example, you might want a trusted collaborator or agent
inside a CoCalc project to debug something on your laptop, workstation, or local
VM.

A reverse SSH tunnel makes this possible. Your computer opens an SSH connection
out to the CoCalc project, and that connection exposes a local SSH server back
inside the project. The project can then SSH to 127.0.0.1 on a temporary port
and reach your computer.

This is useful for short debugging sessions. It is not a general replacement for
careful deployment, VPNs, or normal remote administration.

## Security warning

This is powerful and dangerous. If you expose SSH from your computer to a
project, anyone with shell access to that project and the right SSH credentials
can potentially access your computer through the tunnel.

Before using this:

- only use a project and collaborators you trust,
- prefer a temporary or low-privilege local account,
- do not expose your main laptop account unless you understand the risk,
- keep the tunnel open only while actively using it,
- close the tunnel when the debugging session is done, and
- do not expose other LAN services through the tunnel.

If you are unsure, do not use this workflow.

## Manual setup

This manual workflow assumes you already have SSH access from your computer to a
specific CoCalc project.

In the CoCalc project, open **Project Settings**, use the SSH setup command, and
run it on your computer. The command configures your local SSH client so your
computer can SSH into the CoCalc project.

Next, make sure the CoCalc project has an SSH key that your computer will trust.
In a CoCalc project terminal, check for an existing public key:

~~~sh
ls ~/.ssh/*.pub
~~~

If there is no key, create one:

~~~sh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
~~~

Copy the public key from the project:

~~~sh
cat ~/.ssh/id_ed25519.pub
~~~

On your computer, append that public key to the account that the project should
be allowed to access:

~~~sh
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo '<project-public-key>' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
~~~

Use the account name on your computer when you later connect back from the
project. For example, if your laptop username is alice, the project will connect
as alice@127.0.0.1.

Then make sure your computer has an SSH server running locally.

On Linux, this is usually OpenSSH server:

~~~sh
sudo systemctl status ssh
~~~

If it is not installed or running, install and start it using your distribution's
normal package manager.

On macOS, enable **Remote Login** in System Settings, or start SSH using the
standard macOS sharing controls.

Verify from your computer that local SSH works:

~~~sh
ssh 127.0.0.1
~~~

Use the local username you want the CoCalc project to access.

## Start the reverse tunnel

Run this on your computer:

~~~sh
ssh -N -R 22222:127.0.0.1:22 <cocalc-project-ssh-alias>
~~~

Replace the placeholder with the SSH alias configured by the CoCalc project SSH
setup command.

This keeps a terminal open. While it is running, port 22222 inside the CoCalc
project forwards to port 22 on your computer.

If port 22222 is already in use, choose another high port such as 30022.

## Connect from the CoCalc project

In a CoCalc project terminal, connect back to your computer:

~~~sh
ssh -p 22222 <local-username>@127.0.0.1
~~~

Replace the placeholder with your username on your computer.

To stop access, press Ctrl-C in the terminal where the reverse tunnel is
running. When that SSH command exits, the project can no longer reach your
computer through this tunnel.

## Troubleshooting

If the project says "Connection refused", the SSH server on your computer is
not running, the local SSH port is different, or the reverse tunnel is not
running.

If the project says "Permission denied", the tunnel is working but SSH
authentication to your computer failed. Check the local username and SSH keys.

If the tunnel command says remote port forwarding failed, the chosen project
port is already in use or remote forwarding is not allowed. Try a different high
port.

You can test the forwarded port from the project with:

~~~sh
nc -vz 127.0.0.1 22222
~~~

## Safer future CLI workflow

The safest version of this workflow would be a dedicated cocalc-cli command
that creates a short-lived reverse SSH session instead of exposing your normal
SSH server by hand.

Such a command could:

- create a temporary SSH key,
- start a temporary local sshd bound only to localhost,
- open the reverse tunnel through the existing CoCalc project SSH connection,
- print the exact command to run from the CoCalc project,
- set a timeout, and
- clean up keys, ports, and processes automatically.

That would make temporary debugging much easier while keeping the dangerous part
visible, explicit, and time-limited.
`;
