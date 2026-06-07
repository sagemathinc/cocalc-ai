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

The installer detects the public IPv4 address, uses sslip.io for DNS, obtains a
Let's Encrypt certificate through Caddy, and shows a web onboarding page before
continuing. If the onboarding URL does not open, fix the VM firewall or cloud
network rule for port 443 before continuing.

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

## Current first-release target

The documented first-release target is Ubuntu 24.04 on a fresh public VM with a
public IPv4 address and ports 80 and 443 open. Ubuntu 26.04 is a test target
until provider-level filesystem and package-manager behavior is validated.

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

## Recommended setup

The best local setup is:

1. Install a VM app that can run Ubuntu 24.04.
2. Create an Ubuntu VM with enough disk and memory for your projects.
3. Forward a local port on your computer to port 80 inside the VM.
4. Open CoCalc at a localhost URL such as \`http://localhost:8170/\`.

Using \`localhost\` is better than opening the VM's private IP address directly.
Browsers treat \`localhost\` as a trusted local address, and it is easier to
bookmark and remember.

## Which VM app should I use?

Use the VM app that fits your computer and comfort level.

- **Mac, easiest paid option**: Parallels Desktop. Good general VM support and a
  polished interface.
- **Mac, good free option**: UTM. Works well on Apple Silicon and Intel Macs,
  but networking setup can be a little more manual.
- **Mac, developer-friendly option**: Lima. Good if you are comfortable with
  terminal-based setup and want automatic localhost forwarding.
- **Windows**: VMware Workstation, VirtualBox, or Hyper-V are reasonable choices.
  WSL2 is useful for many Linux tasks, but CoCalc Star should run in a real
  Ubuntu VM.
- **Linux**: KVM/QEMU through virt-manager, libvirt, or GNOME Boxes is usually
  the natural choice.
- **Ubuntu-focused convenience**: Multipass is easy for starting Ubuntu VMs, but
  it is not the best first choice if you need simple port forwarding.

If you do not already have a preference, start with Parallels on Mac, VirtualBox
on Windows, and KVM/QEMU on Linux. On Mac, choose UTM if you want a free desktop
VM app.

## Networking choice

Pick one of these access patterns:

1. **Best**: \`http://localhost:8170/\`

   Configure your VM app to forward host port \`8170\` to guest port \`80\`.
   This gives you a local browser URL and avoids public internet exposure.

2. **Simple fallback**: \`http://<vm-private-ip>/\`

   Many VM apps show a private VM IP address, such as \`192.168.x.y\` or
   \`10.x.y.z\`. You can often open that directly from your host browser. This
   is simple, but it is less polished than a localhost URL.

3. **Avoid for local-only VMs**: public HTTPS with \`sslip.io\`

   The public CoCalc Star installer can set up automatic HTTPS for a public VM.
   That is the right path for cloud servers, not for a VM that only exists on
   your laptop.

## What to expect

A local VM install is private to your machine unless you deliberately expose it
to your network. You can use it without depending on CoCalc's hosted service.
If you are offline, local project tools keep working, but internet-dependent
features still need internet access.

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
