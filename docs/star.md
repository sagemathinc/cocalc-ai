# CoCalc Star - Public VM Appliance

CoCalc Star is the single-VM CoCalc appliance. It is the default path for a
person who has a public Ubuntu VM and wants a shared CoCalc instance without
manual DNS, TLS, port forwarding, or cloud-provider-specific setup.

Status: proof-of-concept moving toward first public release.

## Target User Story

1. Create a public VM on a cloud provider.
2. Open ports 80 and 443 to the VM.
3. Paste one install command.
4. Open the HTTPS onboarding URL.
5. Create the first admin account.
6. Create a project immediately.
7. Use Jupyter, terminals, LaTeX, chat, and agents.
8. Invite another user with minimal registration-token friction.
9. Collaborate in projects on the same VM.

The important product constraint is that this should work for a normal user on
macOS or Windows without SSH port forwarding. The browser reaches the VM
directly through HTTPS.

## Quick Start

On a fresh Ubuntu 24.04 public VM:

```sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh | sudo bash
```

The installer detects the public IPv4 address, uses sslip.io for DNS, configures
Caddy with Let's Encrypt HTTPS, starts a web onboarding page, and then completes
the Star install after the user confirms the page is reachable.

If the onboarding URL does not open, the VM almost certainly has not exposed
port 443 publicly. Fix the cloud firewall, VM firewall, or network security
group before continuing.

## What Star Installs

- A local Launchpad control plane.
- Local Postgres.
- A local project host.
- Rootless Podman project execution.
- A default managed root filesystem with Jupyter and LaTeX.
- Caddy HTTPS on the public VM.
- A first-admin bootstrap URL.
- A reusable invite URL once the instance is initialized.

## Supported Shape For First Release

- Fresh Ubuntu 24.04 VM.
- Public IPv4 address.
- Ports 80 and 443 open.
- One VM, one bay, one project host.
- Public HTTPS via sslip.io and Let's Encrypt.

Ubuntu 26.04 is being tested, but Ubuntu 24.04 should be the documented first
release target until filesystem and package-manager behavior is validated
across providers.

## Product Boundaries

CoCalc Star is not high availability. It is the easiest way to experience a
real shared CoCalc system on your own VM.

Use CoCalc Plus for a local single-user desktop-style install.

Use CoCalc Launchpad when you need the lower-level operator control plane,
custom project-host connectivity, or product-development deployment paths.

Use CoCalc Rocket for production multi-user or multi-bay deployments.

## Release Blockers

- Finish web onboarding polish: clear install steps, time estimate, progress
  bar, and final bootstrap/invite URLs.
- Make the one-line installer short and stable.
- Pause or tolerate unattended upgrades during package installation.
- Keep Star-specific admin UI minimal.
- Ensure the default rootfs is available before first project start.
- Verify Jupyter, terminals, LaTeX, chat, Codex login, and user invites on a
  fresh VM.
- Document explicit scale expectations and default running-project limits.
- Keep Ubuntu 26.04 support as a test target unless it passes provider-level
  validation.
