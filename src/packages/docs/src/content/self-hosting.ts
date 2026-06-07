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
## Local VM goal

The public CoCalc Star appliance is designed for a public VM with automatic
HTTPS. A local laptop VM is a different product path: it is normally for one
operator on their own machine, does not need public DNS, and should not require
SSH port forwarding.

The best local user experience is:

1. Create an Ubuntu VM on the laptop.
2. Expose the VM's web server to the host browser as
   \`http://localhost:<port>/\`.
3. Install CoCalc Star in local mode.
4. Open the local URL, create the first account, and start a project.

This keeps the browser URL on \`localhost\`, which browsers treat much better
than plain HTTP on a private VM IP address.

## What people use in practice

Local virtualization in 2026 is fragmented. There is no single Docker-like
\`-P\` standard for full VMs.

- On macOS, common choices are Parallels Desktop, VMware Fusion, UTM, Multipass,
  Lima, Colima, and OrbStack. Parallels and VMware are general desktop VM tools.
  UTM is popular because it is free/open and works on Apple Silicon. Lima,
  Colima, and OrbStack are common for developer Linux/container workflows.
- On Windows, many developers use WSL2 for Linux development, but Star needs a
  full Ubuntu VM rather than a WSL distribution. Practical VM choices are
  Hyper-V, VirtualBox, VMware Workstation, and Multipass.
- On Linux, KVM/QEMU through libvirt, virt-manager, or GNOME Boxes is the normal
  native path.
- Multipass is convenient for Ubuntu VMs and cloud-init, but it is not the best
  default for Star local mode because its built-in networking story is mostly
  direct VM IP or driver-specific configuration. Port forwarding is documented
  through the VirtualBox driver, not as a universal Multipass feature.

## Recommended local networking

Use these options in order:

1. **Localhost port forward**: host browser opens \`http://localhost:8170/\`,
   and the VM tool forwards host port \`8170\` to guest port \`80\`. This is the
   preferred local appliance experience.
2. **Private VM IP over HTTP**: host browser opens \`http://<vm-private-ip>/\`.
   This is simple and often works, but it is not a browser secure context.
3. **Self-signed or private CA HTTPS**: technically possible, but it adds trust
   setup and certificate-management friction. Do not make this the default
   first-run path.

Do not use the public \`sslip.io\` + Let's Encrypt flow for a VM that is only
reachable from the laptop or LAN. Let's Encrypt needs public domain validation,
and a local VM should not require exposing data to the public internet.

## Port forwarding by VM platform

- **Lima**: best target for an automated local helper. Lima supports automatic
  localhost forwarding for Linux guests and is already optimized for developer
  VM workflows.
- **VirtualBox**: supports NAT port-forwarding rules through the GUI and
  \`VBoxManage\`. This is a practical manual path and an automatable host-helper
  target.
- **Parallels Desktop**: supports port forwarding for VMs using Shared Network,
  but the feature is in Pro/Business-oriented editions. This is a good manual
  path for Mac users who already pay for Parallels.
- **UTM**: supports port forwarding for QEMU backend VMs using Emulated VLAN
  networking. It is a good free Mac option, but a helper must detect the network
  mode before assuming forwarding is available.
- **Multipass**: convenient Ubuntu launcher, but not the cleanest default for
  Star local networking. Use direct VM IP, bridged networking, or Multipass with
  the VirtualBox driver when localhost forwarding is required.
- **Hyper-V, VMware Workstation/Fusion, libvirt/KVM**: viable for advanced users,
  but the first public local-mode docs should not make them the only easy path.

## Product direction

The public release should document manual forwarding for VirtualBox, Parallels,
UTM, and Multipass-with-VirtualBox.

A later host-side helper could provide the premium path:

~~~sh
cocalc-star-local create --vm virtualbox --name cocalc-star --host-port 8170
~~~

That helper would run on the host, not inside the guest. It would detect the VM
tool, configure \`127.0.0.1:8170 -> guest:80\`, pass the correct local URL into
the Star installer, and open the browser when the server is ready.

The guest installer cannot reliably configure host port forwarding by itself.
Docker can offer \`-P\` because Docker owns the host networking layer; a generic
Ubuntu VM does not.
`;
