/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const COCALC_STAR_BODY = `
## What CoCalc Star is

CoCalc Star is a complete CoCalc site in one Docker container: Jupyter, LaTeX,
terminals, chat, agents, and real-time collaboration for a lab, course, or
small team. It is free, and it runs anywhere Docker runs: Docker Desktop on
macOS and Windows, or Docker Engine on Linux.

All of its state (accounts, projects, settings, certificates) lives in one
Docker volume. Upgrading means running a newer image with the same volume;
removing the container and the volume removes all of its data.

## Quick start on your own computer

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
   (macOS or Windows) or Docker Engine (Linux) and start it. Give Docker at
   least 4 CPUs, 8 GB of memory, and 50 GB of disk.
2. In a terminal (on Windows, in PowerShell), run:

~~~sh
docker run -d --name cocalc-star --restart unless-stopped --privileged --cgroupns=host -v cocalc-star:/var/lib/cocalc -p 8170:80 -e COCALC_STAR_HTTP_PORT=8170 sagemathinc/star
~~~

3. Follow the first start, which takes a few minutes:

~~~sh
docker logs -f cocalc-star
~~~

4. Open the printed link that starts with http://localhost:8170 and create
   the first admin account.
5. Create a project and check that Jupyter, a terminal, and LaTeX work.
6. Use the printed invite link to add collaborators.

## On a server with a domain

Point a DNS name at a Linux server with Docker, open TCP port 443 (port 80 is
optional), and pass the domain:

~~~sh
docker run -d --name cocalc-star --restart unless-stopped --privileged --cgroupns=host -v cocalc-star:/var/lib/cocalc -p 443:443 -p 80:80 -e COCALC_STAR_DOMAIN=star.example.com sagemathinc/star
~~~

Certificates are obtained and renewed automatically. Set
\`COCALC_STAR_ACME_EMAIL\` to give the certificate authority a contact address.

## First admin account

The first start prints a single-use link for creating the first admin account.
Print it again with:

~~~sh
docker exec cocalc-star star bootstrap-link
~~~

If it was already used, or you lost access to the admin account, create a new
single-use admin link (valid for 24 hours):

~~~sh
docker exec cocalc-star star admin-link
~~~

## Upgrade

~~~sh
docker pull sagemathinc/star
docker rm -f cocalc-star
~~~

Then run the same \`docker run\` command you installed with. The new container
reinstalls the new release over the existing volume and logs
\`upgrading CoCalc Star from <old> to <new>\`. Running projects stop during the
upgrade and can be started again right away. To go back, run the previous
image tag with the same volume.

## Back up

Stop the container for a consistent copy of the volume:

~~~sh
docker stop cocalc-star
docker run --rm -v cocalc-star:/data -v "$PWD":/backup ubuntu tar -C /data -czf /backup/cocalc-star-backup.tar.gz .
docker start cocalc-star
~~~

Keep backups off the machine that runs Star, and test restoring one into a
fresh volume before relying on it.

## Remove CoCalc Star

This deletes CoCalc Star and all of its data:

~~~sh
docker rm -f cocalc-star
docker volume rm cocalc-star
docker rmi sagemathinc/star
~~~

Star writes no files outside Docker. One thing outlives the container on
Linux hosts that use AppArmor (for example Ubuntu): the \`cocalc-star-podman\`
profile described below stays loaded in the kernel until the host restarts.
It only applies to Star's bundled Podman. To unload it right away:

~~~sh
echo -n cocalc-star-podman | sudo tee /sys/kernel/security/apparmor/.remove
~~~

## Why the container is privileged

Each project runs in its own rootless container with its own storage inside
the CoCalc Star container, so the outer container needs \`--privileged\` and
\`--cgroupns=host\`. Docker is how Star is distributed; the isolation between
users and projects is inside the container. On Linux hosts that restrict
unprivileged user namespaces with AppArmor (Ubuntu 23.10 and later), the
container loads a small AppArmor profile named \`cocalc-star-podman\` that gives
its bundled Podman the same permission the distribution gives its own Podman.

## When to use Star

Use Star for a lab, course, GPU box, agent sandbox, or small team that wants
collaborators in the same browser-based CoCalc workspace on hardware they
control. Star is one machine: it is not high availability or scale-out.

## Product boundaries

- Use CoCalc Plus for a local single-user install.
- Use CoCalc Star for a shared site in one Docker container.
- Use CoCalc Launchpad for a bounded private deployment operated by your team,
  with more control over the environment than Star.
- Discuss CoCalc Rocket with CoCalc when planning a broader private-cloud
  deployment, including infrastructure, operational ownership, and support
  requirements. Rocket has VM and Kubernetes deployment paths.

## Map the connections

| Connection | Default Star path | Operator check |
| --- | --- | --- |
| Browser to the site | The published port (8170 locally, 443 with a domain) reaches Caddy in the container, which forwards to the CoCalc web service on 127.0.0.1:9100 inside the container. | Check the URL, certificate, and websocket access. The **Sign in** page loading does not by itself verify notebooks and terminals. |
| CoCalc to project compute | Star registers one project host inside the same container. | These are internal addresses, not ports to publish. |
| Stored site state | Local PostgreSQL, project storage, configuration, and certificates are all in the \`cocalc-star\` volume. | Back up the volume; the image holds no state. |
| Installation and updates | Images come from Docker Hub (\`sagemathinc/star\`); HTTPS certificates come from Let's Encrypt. | Everything else needed to start is in the image. |

Installing CoCalc on your machine does not prevent applications from
contacting external services. Review the credentials and endpoints selected
for AI tools, remote kernels, package downloads, and user code as part of your
deployment.

## Troubleshooting

~~~sh
docker exec cocalc-star star status
docker exec cocalc-star star doctor
docker exec cocalc-star star smoke
docker exec cocalc-star star logs hub
~~~

\`star smoke\` creates a test account and project and checks Jupyter, LaTeX,
and terminals end to end.

## Agent notes

When helping someone install Star:

1. Confirm Docker is installed and running (\`docker info\`), with at least
   4 CPUs, 8 GB of memory, and 50 GB of disk available to it.
2. Use the one-line \`docker run\` commands above unchanged; they work in macOS
   and Linux shells and in Windows PowerShell.
3. For a public server, the domain must already resolve to the server and
   port 443 must be reachable before starting the container.
4. If the first-admin link is gone, use \`star admin-link\`; do not delete the
   volume to start over unless the user wants to lose their data.
5. After install, verify that the first project starts and Jupyter, a terminal,
   and LaTeX work.
`;

export const COCALC_STAR_LOCAL_VM_BODY = String.raw`
## Why run CoCalc Star on your own computer?

If you tried CoCalc and want the same kind of browser-based workspace on your
own hardware, run CoCalc Star locally. It is especially useful when you want:

- a very private CoCalc instance that stays on your laptop or desktop server,
- very low latency because the server is physically near you,
- to use a powerful laptop, workstation, or home server you already own,
- to keep working while flying or away from reliable internet, or
- to experiment with CoCalc Star without renting a cloud server.

## Use Docker Desktop

CoCalc Star runs in one Docker container. Install Docker Desktop (macOS or
Windows) or Docker Engine (Linux), then follow the quick start in the
[CoCalc Star guide](/docs/self-hosting/cocalc-star). You open CoCalc in your
normal browser at http://localhost:8170.

Everything Star stores is in one Docker volume, so stopping the container frees
its memory and CPU, and removing the container and volume removes it
completely.

Earlier versions of this page described running Star inside a Lima virtual
machine. Docker replaces that path: it is simpler to install, to upgrade, and
to undo.
`;

export const INSTALL_CHROMIUM_BODY = `
## Why this matters on Ubuntu

Ubuntu's \`chromium-browser\` package is often not a real browser package. On
many Ubuntu releases it is a small transition package that prints a message
telling you to install the Chromium snap:

~~~text
Command '/usr/bin/chromium-browser' requires the chromium snap to be installed.
Please install it with:

snap install chromium
~~~

That snap package is usually the wrong answer for containers, rootless Podman,
CI images, and many server-style CoCalc deployments. Snap expects system
services and confinement features that are often absent or deliberately disabled
inside containers.

For container and server images, prefer a normal Debian package that installs a
real \`/usr/bin/chromium\` binary and can be upgraded with \`apt upgrade\`.

## Recommended apt recipe: xtradeb Chromium

The xtradeb applications PPA publishes real Chromium \`.deb\` packages for
Ubuntu. The recipe below:

1. Adds the PPA using a deb822 source file.
2. Installs the PPA signing key in \`/usr/share/keyrings\`.
3. Pins Ubuntu's snap transition package so upgrades do not reinstall it.
4. Prefers xtradeb's real Chromium packages.
5. Installs Chromium, ChromeDriver, and the Chromium sandbox package.
6. Adds a \`chromium-browser\` compatibility wrapper for scripts that expect
   that command name.

Copy and paste this on Ubuntu:

~~~sh
set -euo pipefail

sudo gpg --keyserver hkps://keyserver.ubuntu.com \\
  --recv-keys 5301FA4FD93244FBC6F6149982BB6851C64F6880
sudo gpg --export 5301FA4FD93244FBC6F6149982BB6851C64F6880 \\
  | sudo tee /usr/share/keyrings/xtradeb-apps.gpg >/dev/null

. /etc/os-release
sudo tee /etc/apt/sources.list.d/xtradeb-apps.sources >/dev/null <<EOF
Types: deb
URIs: https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/
Suites: \${VERSION_CODENAME}
Components: main
Signed-By: /usr/share/keyrings/xtradeb-apps.gpg
EOF

sudo tee /etc/apt/preferences.d/chromium-real-deb >/dev/null <<'EOF'
Package: chromium-browser
Pin: version 2:1snap*
Pin-Priority: -1

Package: chromium chromium-common chromium-driver chromium-headless-shell chromium-l10n chromium-sandbox chromium-shell
Pin: release o=LP-PPA-xtradeb-apps
Pin-Priority: 700
EOF

sudo apt-get update
sudo apt-get purge -y chromium-browser || true
sudo apt-get install -y chromium chromium-driver chromium-sandbox

sudo tee /usr/local/bin/chromium-browser >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/chromium "$@"
EOF
sudo chmod 0755 /usr/local/bin/chromium-browser
~~~

## Verify the install

Run:

~~~sh
which -a chromium chromium-browser
chromium --version
chromium-browser --version
chromedriver --version

chromium --headless=new --disable-gpu \\
  --dump-dom 'data:text/html,<h1>chromium works</h1>'
~~~

You should see \`/usr/bin/chromium\` for the real browser and
\`/usr/local/bin/chromium-browser\` for the compatibility wrapper. The
\`chromium-browser\` command should no longer print the snap installation
message.

## Podman and sandbox notes

First try Chromium with its sandbox enabled:

~~~sh
chromium --headless=new --disable-gpu \\
  --dump-dom 'data:text/html,<h1>sandbox works</h1>'
~~~

If the container runtime, kernel, or user namespace setup blocks the Chromium
sandbox, use \`--no-sandbox\` for automation inside that container:

~~~sh
chromium --headless=new --no-sandbox --disable-gpu \\
  --dump-dom 'data:text/html,<h1>no sandbox fallback works</h1>'
~~~

Use \`--no-sandbox\` only when the container boundary is the intended sandbox.
For normal desktop use, leave Chromium's own sandbox enabled.

## If \`add-apt-repository\` is available

On full Ubuntu systems with \`software-properties-common\` installed, the PPA
can also be added with:

~~~sh
sudo add-apt-repository ppa:xtradeb/apps -y
sudo apt-get update
~~~

Still keep the apt preferences file above. It is what prevents Ubuntu's
\`chromium-browser\` snap transition package from coming back during later
\`apt upgrade\` runs.

## Troubleshooting

- If \`apt-cache policy chromium\` has no xtradeb candidate, check that the PPA
  publishes your Ubuntu codename and that \`Suites:\` in
  \`/etc/apt/sources.list.d/xtradeb-apps.sources\` matches
  \`VERSION_CODENAME\` from \`/etc/os-release\`.
- If \`chromium-browser\` still runs \`/usr/bin/chromium-browser\`, refresh your
  shell command cache with \`hash -r\` or open a new shell.
- If headless Chromium logs DBus warnings in a container but still prints the
  DOM, the warnings are usually harmless.
- If the PPA is temporarily unavailable, do not install Ubuntu's snap transition
  package as a fallback in containers. Use a pinned browser snapshot only as a
  temporary workaround, then return to an apt-managed package.
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
