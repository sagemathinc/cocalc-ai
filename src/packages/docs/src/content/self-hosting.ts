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
