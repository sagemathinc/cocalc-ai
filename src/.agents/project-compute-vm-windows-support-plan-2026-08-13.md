# Project Compute VM Windows Support Plan

Date: 2026-08-13

Status: first usable version implemented and deployed to staging only;
production deployment is deferred.

Related specification:
[Project Compute VM v2 Specification](./project-compute-vm-v2-spec-2026-08-12.md).

## First Usable Staging Implementation

The first usable GCP Windows Server 2022 implementation was completed on
2026-08-13 in these commits:

- `5c983bbde0`: operating-system schema/catalog, pricing, GCP provisioning,
  Windows bootstrap, SSH/RDP CLI and API, and frontend support;
- `ce0f69cc0a`: fail-closed encoded-PowerShell readiness and resilient CLI
  wait polling;
- `02c319a056`: avoid assigning PowerShell's read-only `$HOME` variable during
  bootstrap; and
- `822f99dce7`: synchronize post-bootstrap Windows SSH keys through the bay
  controller with strict `authorized_keys` ACLs.

Staging is running these immutable artifacts:

- static: `20260813T213801Z-5c983bbd-windows-vm-5c983bbde0`;
- project bundle: `20260813T213840Z-5c983bbd-windows-vm-5c983bbde0`;
- project tools: `20260813T215509Z-ce0f69cc-windows-vm-readiness-ce0f69cc0a`;
  and
- hub: `20260813T221826Z-822f99dc-windows-vm-ssh-822f99dce7`.

Live staging validation covered:

- clean Windows Server 2022 provisioning with fail-closed bootstrap revision
  observation;
- the `user` administrator account, `C:\Users\user`, PowerShell, OpenSSH, and
  Terminal Services;
- the project-managed `ssh <vm-name>` alias and account `cocalc vm ssh` key
  authorization;
- one-time fresh-auth RDP password rotation, a reachable localhost RDP tunnel,
  and externally blocked TCP 3389;
- immutable Windows license pricing, including no license component in the
  stopped price;
- explicit stop/start with address release, stable DNS identity, regenerated
  project SSH config, and persistent boot-disk data;
- a Spot request with Standard fallback: GCP reported no Spot capacity, the
  bounded fallback activated, and the Windows VM reached readiness; and
- complete deletion of all smoke VMs, boot disks, addresses, DNS records, and
  SSH config, with no matching provider orphans.

The static, project bundle, tools, and hub route smoke tests pass on staging;
the hub route check reports all four workers healthy. The full monorepo
typecheck passes, and the server compute suite reports 78 passing tests and 2
intentional skips. A forced provider preemption was not simulated, so actual
Spot preemption recovery remains a production-readiness validation item rather
than a completed staging claim.

## Executive Decision

Add **Windows Server** as a GCP-only operating-system choice for managed
compute VMs. Windows uses the same logical VM product, ownership, funding,
stable address, DNS, Spot recovery, SSH authorization, and agent capability
model as Linux. It is not a separate provider or a parallel lifecycle system.

The first release is intentionally narrow:

- GCP only;
- Windows Server 2022 Desktop Experience (`windows-cloud/windows-2022`);
- x86-64 only;
- CPU machine types known to support the selected Windows image;
- persistent boot disk, but no detachable Windows home/profile volume;
- SSH user `user` with administrative privileges;
- TCP 22 and 443 remain the only public ingress ports; and
- native RDP is reached through an SSH tunnel, not public TCP 3389.

Spot VMs and CoCalc's existing recovery policy are a primary use case. A Spot
preemption must retain the Windows boot disk, stable public address, DNS name,
SSH alias, and logical VM identity. If the user authorizes Standard fallback,
the existing bounded fallback policy applies unchanged.

This plan is for Windows **Server**, whose on-demand license is supplied and
metered by GCP. Windows 10/11 client images, BYOL, SQL Server images, Active
Directory controllers, and domain joining are separate products and are not
part of this work.

## Product Contract

A Windows managed VM has this contract:

```text
Provider:             GCP
Operating system:     Windows Server 2022 Desktop Experience
Architecture:         x86-64
SSH user:             user
Windows profile:      C:\Users\user
Administrative use:  local Administrators membership
Persistent storage:  persistent boot disk
Public address:       stable while desired state is running
Public hostname:      stable for the logical VM lifetime
Public ingress:       TCP 22 and TCP 443
RDP:                  localhost tunnel over authenticated SSH
Cloud identity:       no guest service account
```

The guest remains hostile and root-equivalent, just like a Linux managed VM.
The Windows account can install software, change system configuration, disable
services, or make the machine unreachable. It receives no CoCalc account,
database, hub, Cloudflare, or provider credential.

The create UI must show the complete hourly price before purchase:

```text
Compute price
+ Windows Server license
+ CoCalc surcharge, if configured
= VM hourly price
```

Storage and public egress remain separate line items under the existing product
rules. The UI must state clearly that Spot discounts the compute resource but
do not discount the Windows Server license.

## Goals

1. Make a Windows Server VM as easy to create, stop, recover, SSH into, and
   delete as a Linux managed VM.
2. Make `ssh <vm-name>` work from the attached project without GCP IAM or a
   user-created cloud service account.
3. Preserve a Windows development environment across Spot preemptions.
4. Provide RDP without exposing a password-authenticated service to the public
   Internet.
5. Quote, authorize, accrue, and display the Windows license charge correctly.
6. Keep account and project credentials out of the guest.
7. Reuse the provider-neutral v2 lifecycle rather than creating Windows-only
   control-plane state.

## Non-goals

- Windows 10 or Windows 11 client licensing.
- Customer BYOL or imported images.
- SQL Server licensed images.
- Windows Server Core in the first release.
- ARM Windows VMs.
- Nebius Windows VMs.
- Active Directory, domain joining, or domain-controller support.
- A public RDP firewall rule.
- Browser-embedded RDP, Apache Guacamole, or hub-proxied desktop traffic.
- More than two interactive RDP sessions or managed RDS CALs.
- Moving `C:\Users\user` to the existing ext4 persistent-home product.
- Cross-OS conversion of an existing VM or volume.
- Managed Windows application installation beyond guest/bootstrap essentials.
- Automatic Windows snapshots, image capture, or disaster recovery.

## Authority and Data Plane

The multibay rules remain unchanged:

- the owner account's home bay is authoritative for VM state, funding,
  password-reset authorization, and provider work;
- the attached project's owning bay is authoritative for project membership
  and its managed `~/.ssh/config` block;
- the VM authority bay performs GCP mutations using the dedicated managed-VM
  credential;
- SSH, HTTPS, and tunneled RDP flow directly between the client/project and VM;
  and
- the hub does not proxy terminal, desktop, or application traffic.

Password generation is a control-plane exception: the authoritative bay asks
the GCP Windows guest agent to generate a credential, returns it once to the
authorized human, and immediately discards it. The password is never delivered
to the attached project or an ambient Codex turn.

## Data Model and API

### VM operating-system identity

Add first-class immutable OS fields to the VM record and public API:

```ts
type ManagedComputeOperatingSystem = "linux" | "windows";

operating_system: ManagedComputeOperatingSystem;
operating_system_version: "ubuntu-24.04" | "windows-server-2022";
```

Existing rows migrate to `linux` and `ubuntu-24.04`. Do not infer the OS later
from an image-family string. Creation fixes the OS for the logical VM lifetime;
changing OS requires creating a new VM.

Keep the resolved provider image in the immutable pricing/provisioning snapshot:

```text
source_image_project = windows-cloud
source_image_family  = windows-2022
image_license        = windows-server-2022-dc
```

The API representation also exposes:

```ts
rdp_supported: boolean;
public_rdp: false;
os_license_hourly_price: string;
```

Do not encode RDP support by adding 3389 to `public_ports`; that field must
continue to describe actual public ingress.

### Creation input

Extend the create input and CLI with an explicit OS option:

```text
--os linux
--os windows-server-2022
```

The UI presents **Linux** and **Windows Server 2022**, not raw image-family
names. Linux remains the default. Server-side admission rejects all invalid
combinations even if the caller bypasses the UI:

- Windows with a provider other than GCP;
- Windows with ARM64;
- a machine series unsupported by the selected Windows image;
- a Windows image with a home volume;
- an unsupported GPU/machine/image combination; or
- an unpriced Windows license.

### Catalog

The live managed-compute catalog must include OS compatibility. Add an image
catalog section or per-machine compatibility field rather than duplicating a
hard-coded frontend list. The server is authoritative for:

- supported Windows versions;
- image project and family;
- architecture;
- compatible machine series and zones;
- minimum and recommended boot-disk sizes;
- RDP/SSH capabilities; and
- license pricing.

When Windows is selected, the frontend filters architecture, machine, region,
zone, and GPU choices using this catalog. Invalid choices are reset
immediately, exactly as machine/GPU compatibility is handled elsewhere. Sort
by price must re-run after the OS, region, zone, Spot, or machine options
change.

Start with Windows CPU machines only. Windows GPU support requires a separately
tested image/driver compatibility matrix and must not appear merely because a
GCP zone has a GPU. Windows Server 2022 excludes several accelerator-focused
machine families, including A3/A4, even though those machines are otherwise in
the GCP catalog.

### Fresh-auth password action

Add an owner-only, GCP-Windows-only operation such as:

```ts
resetWindowsPassword({
  id_or_name,
  confirm_name,
  username: "user",
});
```

Requirements:

- cookie-backed fresh auth is mandatory;
- project-scoped credentials and Codex turn grants are denied;
- the VM must be running and observed as the same provider generation;
- the username is fixed to `user` initially;
- the action is rate-limited per VM and account;
- the confirmation warns that resetting an existing password can make EFS or
  other password-encrypted data inaccessible;
- the audit record contains actor, VM, generation, time, and outcome only;
- the password, encrypted password, and private decryption key are redacted
  from logs, traces, errors, Redux, and durable database state; and
- the response displays the password exactly once.

This operation cannot provide ordinary mutation idempotency without retaining
the secret. If the response is lost after GCP resets the password, report an
ambiguous outcome and require another explicit reset. Do not persist an
encrypted recoverable password merely to make retries convenient.

## GCP Provider Work

### OS-aware host specification

Extend `HostSpec` with an explicit guest OS or OS-specific metadata map. Do not
pass a PowerShell program through the Linux `startup-script` metadata key.

For Windows Server 2022, provider creation uses:

```text
source image project: windows-cloud
source image family:  windows-2022
metadata:
  enable-windows-ssh: TRUE
  sysprep-specialize-script-ps1: <first-boot bootstrap>
  windows-startup-script-ps1:    <idempotent every-boot reconciliation>
```

The generic GCP adapter currently synthesizes Linux startup metadata and SSH
commands. Split these behind OS-specific helpers while retaining one instance,
disk, network, address, and scheduling implementation.

The persistent boot disk must remain `autoDelete: false` during Spot recovery
and be reused by provider generation. Explicit VM deletion still deletes the
boot disk under the existing product contract.

### Windows bootstrap

Create a PowerShell bootstrap renderer alongside the existing Bash renderer.
Use fixed metadata fields and safe base64/JSON transport for key material; do
not interpolate untrusted VM names or keys into executable PowerShell syntax.

The first-boot bootstrap must:

1. install/update the GCP Windows guest environment as required;
2. install `google-compute-engine-ssh` using GooGet;
3. enable and start OpenSSH Server;
4. create the local `user` account if absent;
5. add `user` to the local `Administrators` group;
6. install only the expected SSH public keys with Windows-correct ACLs;
7. configure OpenSSH to allow public-key login and local TCP forwarding;
8. configure PowerShell as the intended SSH shell;
9. enable Remote Desktop locally and start `TermService`;
10. keep Windows Defender Firewall closed to public 3389 while permitting the
    local SSH tunnel destination;
11. allow inbound TCP 443 in the guest firewall for user-managed HTTPS;
12. write the bootstrap revision to
    `C:\ProgramData\CoCalc\ManagedVm\bootstrap-ready`; and
13. emit bounded, non-secret bootstrap diagnostics to the serial console.

The every-boot script must be idempotent and repair only CoCalc-owned
configuration: SSH service state, authorized keys, administrative membership,
RDP service state, and the readiness marker. It must not reset the Windows
password, reinstall arbitrary software, rewrite user files, or disable Windows
Update.

Use Windows Server's existing GCP guest agent for metadata and Windows
licensing. Confirm the managed VPC permits outbound activation traffic to
`kms.windows.googlecloud.com` (`35.190.247.13/32`) without weakening the current
private-network egress denials.

### Readiness

Make readiness OS-aware. Windows can take materially longer than Ubuntu during
sysprep, package installation, and updates, so use a Windows-specific bounded
timeout with phase logging rather than globally extending Linux readiness.

After TCP 22 is available, the owner-bay controller logs in with its existing
ephemeral/private identity as `user` and runs a noninteractive PowerShell
probe that verifies:

```text
$env:USERNAME is user
$env:USERPROFILE is C:\Users\user
user belongs to local Administrators
sshd is Running
TermService is Running
bootstrap-ready contains the expected revision
the observed Windows version matches the VM contract
```

Only then may the VM become `ready`, receive DNS, and update the project SSH
config. Capture provider/serial diagnostics on timeout without logging key or
password material.

### SSH authorization after creation

The existing `authorizeSshKey` action must branch by OS:

- Linux keeps the current metadata and `authorized_keys` behavior.
- Windows updates the CoCalc-owned key set and lets the every-boot/reconcile
  path install it with correct ACLs.

Avoid relying solely on project-level GCP metadata. VM-specific keys and
`block-project-ssh-keys=TRUE` remain security invariants. The controller key is
authorized for readiness/reconciliation but never exposed to the customer.

### Windows password generation protocol

GCP does not expose password reset as a simple instance method. Implement the
documented protocol inside the GCP provider adapter:

1. generate an ephemeral 2048-bit RSA key pair in memory;
2. fetch instance metadata and its fingerprint;
3. add a short-lived `windows-keys` request containing `user`, expiry, RSA
   modulus, and exponent without disturbing unrelated metadata;
4. retry metadata fingerprint conflicts by re-reading and merging;
5. poll serial port 4 with a strict timeout;
6. match the response to the request modulus and provider generation;
7. decrypt the returned password in memory;
8. remove the completed request from instance metadata; and
9. zero/discard private-key and plaintext buffers as far as Node permits.

Never place a chosen plaintext password in startup-script metadata. Never log
serial-port payloads wholesale because they contain the encrypted credential
and may contain unrelated guest diagnostics.

## Pricing, Authorization, and Billing

Windows Server is a premium image charge in addition to VM compute. At the
time of this plan, GCP documents `$0.046/hour` per visible vCPU for normal
machine types, with a one-minute minimum and per-second billing afterward.
This value must be fetched/validated through the production pricing catalog;
do not make the documentation value an unreviewed permanent constant.

Add a durable pricing component:

```text
os_license_hourly_price
```

The existing `spot_hourly_price` and `on_demand_hourly_price` remain the total
customer VM rates. Their pricing snapshots must break out:

```text
provider compute
premium OS license
CoCalc surcharge
total
source SKU identifiers and observation time
```

For Windows, both totals include the same premium OS component because GCP
does not apply the Spot discount to premium operating-system licenses. The
admission service must fail closed if either compute or license pricing is
missing. The UI must never offer “Create VM” while saying that Windows pricing
is unavailable.

Funding behavior remains identical across site-funded, account-postpaid, and
account-prepaid lanes. Authorization uses the complete total rate. Accrual
charges Windows only while the provider VM is observed running, including
Spot and Standard fallback intervals, and stops license accrual when the VM is
terminated/stopped. Storage remains billable while retained.

Add focused reconciliation against GCP billing SKUs during staging to catch
license undercharging before production rollout.

## Storage

The first release does not support `home_volume_id` for Windows. The existing
home-volume product is an ext4 filesystem mounted at `/home/user`; it cannot be
safely reused as a Windows profile disk.

Use a persistent boot disk instead:

- recommend 80 GB in the UI;
- enforce a product minimum appropriate for Windows updates and development
  tools;
- preserve it across stop/start and Spot provider generations; and
- delete it only on explicit VM deletion.

The UI must explain this difference rather than showing Linux home-volume
controls in a disabled or misleading state.

A later storage phase may add an independent NTFS data disk mounted as `D:`.
Do not initially relocate `C:\Users\user`; Windows profile relocation has
upgrade, ACL, registry, application, and recovery implications that deserve a
separate specification.

## SSH and Agent Experience

The project-managed SSH config remains:

```sshconfig
Host <vm-name>
  HostName <stable-vm-hostname>
  User user
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

Thus `ssh windows-build` works from the attached project exactly as it does for
Linux. `cocalc vm ssh <name>` and command execution must use the row's
`ssh_user` rather than hard-coding Linux assumptions.

`rsync` is not a Windows contract. Make `cocalc vm rsync` reject Windows with a
clear message and add/document an OS-neutral `scp` or SFTP path. The catalog,
`vm get`, and `vm list --long` expose the OS so an agent can choose PowerShell,
SFTP, or Windows-compatible commands.

Codex turn capabilities remain narrow and fresh-auth-approved. They may allow
create/start/stop/delete/SSH-key authorization for a Windows VM under the same
policy as Linux, but they do not allow password reset or reveal RDP
credentials. A turn can manage the VM effectively through SSH public-key auth
without possessing a reusable account session or GCP credential.

## RDP Design

### Network policy

Do **not** add public TCP 3389 to the managed-compute firewall. Password RDP on
`0.0.0.0/0` creates needless scanning, brute-force, and vulnerability exposure.
Keep the authoritative public-port policy at `[22, 443]`.

RDP uses SSH local forwarding:

```text
127.0.0.1:<ephemeral-port> -> SSH -> VM 127.0.0.1:3389
```

This reuses stable DNS, project/account SSH authorization, host-key handling,
and direct data-plane traffic. The tunnel ends when the local SSH process
exits. No RDP bytes flow through the CoCalc hub.

### CLI

Add:

```text
cocalc vm windows-password reset <vm>
cocalc vm rdp <vm>
```

`windows-password reset` requires account authentication and fresh auth,
prints the generated username/password once, and suppresses normal structured
logging of the secret. JSON output must be opt-in and carry an explicit secret
warning; shell history never contains the password.

`vm rdp`:

1. confirms that the VM is a ready Windows VM;
2. authorizes the caller's SSH key using the existing secure flow;
3. reserves an unused loopback port;
4. starts `ssh -N -L <port>:127.0.0.1:3389 user@<hostname>` with agent and
   remote forwarding disabled;
5. writes a mode-0600 temporary `.rdp` file containing loopback address and
   username, but no password;
6. launches `mstsc` on Windows, `open` with an installed RDP client on macOS,
   or `xfreerdp`/prints instructions on Linux; and
7. removes the temporary file and tunnel on exit or signal.

Never weaken host-key verification to make RDP convenient. If the platform
cannot launch an RDP client, print the exact tunnel and connection target.

### Frontend

The Connect popover for Windows shows:

- DNS hostname;
- `ssh <vm-name>` from the attached project;
- full SSH command for another machine;
- public ports 22 and 443;
- “RDP is private and tunneled over SSH”;
- the `cocalc vm rdp <vm-name>` command; and
- a fresh-auth **Generate/reset Windows password** action.

Password output lives only in local component state, is visibly one-time, has
a Copy button, and disappears when the popover closes or after a short timer.
It must not enter Redux, query caches, local storage, analytics, error reports,
or clipboard automatically.

Browser-native RDP is deferred. If later implemented, it requires a separate
data-plane and security design rather than routing desktop traffic through the
hub opportunistically.

## Frontend Create Experience

Add an operating-system selector near provider/architecture because OS affects
all later choices. Selecting Windows must:

- force provider to GCP;
- force architecture to x86-64;
- remove unsupported regions/zones/machine series from choices;
- hide or disable home-volume controls with an explanation;
- hide GPU choices in the first release;
- change the recommended boot disk to 80 GB;
- show the Windows license as a separate hourly cost;
- show Spot and Standard totals including that license;
- warn that Windows starts more slowly and Spot can interrupt a session; and
- explain that RDP is available securely through SSH after creation.

Creation errors stay visible beside the Create button in the tall modal. The
equivalent CLI command includes `--os windows-server-2022` and omits Linux-only
volume/GPU options.

VM cards and detail views display a Windows badge, Windows version, license
component, SSH command, RDP command, and current recovery state.

## Known Risks and Prototype Questions

These are validation requirements, not reasons to fork the architecture:

- GCP's `google-compute-engine-ssh` Windows integration and
  `enable-windows-ssh` metadata are currently Preview. The prototype must prove
  reliable first boot, reboot, key rotation, and Spot recovery. If it is not
  reliable enough, use the supported Windows OpenSSH capability directly while
  retaining the same CoCalc key/readiness contract.
- Windows Update and sysprep can make first readiness significantly slower and
  less predictable than Ubuntu. Measure the distribution before selecting
  timeout and retry policy; do not hide a hung bootstrap behind an arbitrarily
  long timeout.
- A password reset can invalidate access to EFS and other data protected by the
  previous Windows credential. Require explicit confirmation every time and do
  not reset automatically as part of `vm rdp`.
- Some software advertised as “Windows” supports only Windows client editions,
  not Windows Server. Product copy must say Windows Server precisely and must
  not imply Windows 11 compatibility.
- Native RDP client discovery differs across Windows, macOS, Linux, and mobile.
  The CLI must degrade to exact manual tunnel instructions rather than opening
  public 3389 when it cannot launch a client.
- The premium-image license may dominate the price of small Spot VMs. Pricing
  presentation must make this visible rather than implying the entire VM
  receives the advertised Spot discount.
- Abrupt Spot preemption can interrupt Windows updates and interactive desktop
  work. Recovery testing must include interrupted updates and repeated starts,
  not only an idle desktop.

## Security and Abuse Review

Windows support must pass an explicit security/abuse audit before production:

1. Verify no VM service account is attached and the metadata server cannot
   mint cloud credentials.
2. Verify only the managed network tag applies and only TCP 22/443 are public.
3. Verify TCP 3389 is unreachable externally in every configured region.
4. Verify SSH forwarding permits local RDP but remote/agent forwarding remains
   disabled by generated client commands.
5. Verify project SSH keys cannot mutate lifecycle, funding, or passwords.
6. Verify only the owner with fresh auth can reset a Windows password.
7. Verify all secret fields are redacted from hub logs, Conat tracing,
   PostgreSQL audit payloads, browser crash reports, and CLI diagnostics.
8. Verify metadata updates preserve `block-project-ssh-keys`, startup scripts,
   labels, and unrelated provider metadata under fingerprint conflicts.
9. Verify serial-port parsing accepts only the matching modulus/generation and
   has strict size/time limits.
10. Verify password-reset rate limits and notification/audit visibility.
11. Verify Windows image families and license SKUs come only from an
    administrator-controlled allowlist.
12. Verify a compromised guest cannot reach private VPC ranges or other
    managed VMs under the existing egress/ingress invariants.

Generate an account security notification after password reset. Do not email
the password.

## Observability and Operations

Add OS labels to lifecycle and billing metrics without high-cardinality VM IDs
in fleet-wide series. Record bounded phase timings for:

- provider instance creation;
- sysprep/bootstrap completion;
- SSH port availability;
- SSH authenticated readiness;
- RDP service readiness;
- Spot preemption detection and recovery;
- password-generation latency and outcome; and
- Windows license accrual reconciliation.

Never include password protocol payloads in telemetry. Keep per-VM details in
structured logs/audit records with secret redaction.

Operational alerts should distinguish Windows's longer first boot from a
stalled bootstrap. Surface the last safe bootstrap phase and selected serial
diagnostics in admin tooling. Add fleet inventory checks for:

- Windows VMs with unsupported image families;
- running Windows VMs missing license pricing;
- Windows VMs with public 3389 exposure;
- Windows VMs with an attached service account;
- stale `windows-keys` metadata requests; and
- boot disks or addresses orphaned by failed provider generations.

## Implementation Phases

### Phase 0: live prototype and pricing proof

1. Inventory the operator's working Windows VM configuration without copying
   credentials or private data.
2. Create one manually controlled staging Windows Server 2022 instance in the
   dedicated managed-compute GCP project and VPC.
3. Validate image/machine compatibility, KMS activation, OpenSSH package,
   PowerShell bootstrap, local-user behavior, RDP-over-SSH, and stop/start.
4. Query the Cloud Billing Catalog and actual GCP billing export for compute
   and Windows license SKUs.
5. Delete all prototype resources and audit for address/disk/firewall orphans.

Exit criterion: exact provider behavior and price composition are known before
adding customer-facing admission.

### Phase 1: model, catalog, pricing, and admission

1. Add immutable OS fields and migrate existing rows to Linux.
2. Add Windows image compatibility and license components to the server
   catalog.
3. Implement fail-closed total pricing and funding authorization.
4. Add API/CLI inputs and comprehensive invalid-combination tests.
5. Expose OS and price breakdowns in VM output without enabling creation yet.

Exit criterion: every offered Windows configuration has a valid image and
complete quoted total.

### Phase 2: provider and guest lifecycle

1. Make GCP metadata/startup handling OS-aware.
2. Implement the PowerShell bootstrap and Windows readiness probe.
3. Reuse persistent boot disk, address, DNS, stop/start, deletion, and Spot
   recovery operations.
4. Make SSH authorization/reconciliation OS-aware.
5. Add Windows-specific timeout diagnostics and orphan reconciliation.

Exit criterion: a site-funded staging Windows VM completes repeated
create/SSH/stop/start/recovery/delete cycles without manual GCP intervention.

### Phase 3: frontend, CLI, and project integration

1. Add OS-filtered creation controls and full cost disclosure.
2. Add Windows-aware VM cards and Connect content.
3. Preserve exact project SSH aliases.
4. Make CLI SSH commands use VM OS/user data and guard Linux-only rsync.
5. Add `vm rdp` tunnel/client orchestration.

Exit criterion: a tester can create and use Windows through CoCalc without
opening the GCP console.

### Phase 4: password generation

1. Implement and test the ephemeral RSA/metadata/serial-port protocol.
2. Add owner/fresh-auth/rate-limit/audit enforcement.
3. Add one-time CLI and frontend secret presentation.
4. Run an explicit secret-leak and ambiguous-failure audit.

Exit criterion: native RDP works from a fresh account session and no password
or decryptable equivalent appears in durable CoCalc state.

### Phase 5: staged canary and production release

1. Enable only for site admins on staging.
2. Complete the lifecycle, billing, security, and failure matrix below.
3. Run for several days across real Spot availability and Windows Update.
4. Enable a small production account allowlist with a strict active-VM and
   spend cap.
5. Compare GCP invoice/export charges to CoCalc accrual daily.
6. Expand only after no secret, pricing, recovery, or orphan discrepancies.

## Test Matrix

### Unit and package tests

- OS schema migration and serialization.
- Catalog compatibility filtering by OS, architecture, machine, zone, and GPU.
- Windows license SKU normalization and total-rate arithmetic.
- Site-funded, postpaid, and prepaid authorization using complete totals.
- PowerShell bootstrap rendering and hostile-key escaping.
- GCP metadata key selection for Linux versus Windows.
- Windows readiness command rendering and error classification.
- SSH key reconciliation and Windows ACL command generation.
- Password protocol RSA generation, modulus matching, decryption, expiry,
  metadata fingerprint conflict, timeout, malformed serial output, and cleanup.
- Secret redaction in success, provider error, timeout, and RPC tracing.
- Fresh-auth, owner, project credential, and turn-grant authorization tests.
- CLI SSH/RDP process cleanup and Windows rsync rejection.
- Frontend option reset/sorting and complete price rendering.

### Staging lifecycle tests

Use a low-cost x86 machine and site-funded lane first:

1. Create Windows Server 2022 on Standard.
2. Verify quoted versus stored compute/license/total rates.
3. Verify stable address and Cloudflare DNS.
4. Verify `ssh <name>` from the project and `cocalc vm ssh` externally.
5. Verify `user`, profile path, administrator membership, PowerShell, and
   bootstrap revision.
6. Bind an HTTPS test service to 443 and verify public access.
7. Verify public 3389 is closed from an external network.
8. Generate/reset the password and connect through `cocalc vm rdp`.
9. Verify password output is absent from logs, audit JSON, Redux, and crash
   reports.
10. Stop and restart; verify boot disk, files, IP/DNS policy, SSH, and RDP.
11. Create as Spot, simulate/provider-stop a preemption, and verify automatic
    recovery with the same logical VM and disk.
12. Exercise authorized Standard fallback and confirm total prices include the
    unchanged Windows license component.
13. Update SSH keys and verify removed keys lose access.
14. Delete the VM and verify instance, boot disk, address, DNS, SSH config, and
    purchases reconcile correctly.
15. Run provider orphan inventory after injected failures at address, disk,
    instance, DNS, readiness, and password phases.

Repeat funding checks for postpaid and prepaid accounts, including insufficient
funds, expiry, stop, and deletion. Do not rely on a successful visual RDP test
alone; validate every control-plane and billing invariant directly.

## Rollback

Windows creation is protected by a separate site setting and emergency stop.
Rollback disables new Windows creation and password generation without
affecting Linux VM lifecycle or already-running Windows VMs. Existing Windows
VMs must retain stop/start/delete and SSH access so rollback cannot strand a
billable resource.

Do not roll back by deleting Windows rows or provider resources. Reconciliation
must continue charging observed running resources and permit explicit cleanup.

## Deferred Follow-up

After the first release is stable, consider in this order:

1. an independent NTFS `D:` data volume;
2. Windows GPU configurations with tested display/compute drivers and any
   additional NVIDIA vWS licensing;
3. Windows Server 2025;
4. browser-native RDP behind a dedicated audited data-plane service;
5. optional temporary source-IP-restricted RDP as an alternative to SSH
   tunneling; and
6. BYOL/client Windows only after legal, provider, image-import, and support
   requirements are understood.

## Documentation References

- [GCP Windows Server image and machine support](https://docs.cloud.google.com/compute/docs/images/os-details)
- [Create and manage Windows Server VMs](https://docs.cloud.google.com/compute/docs/instances/windows/creating-managing-windows-instances)
- [Connect to Windows VMs using SSH](https://docs.cloud.google.com/compute/docs/connect/windows-ssh)
- [Windows startup scripts](https://docs.cloud.google.com/compute/docs/instances/startup-scripts/windows)
- [Automating Windows password generation](https://docs.cloud.google.com/compute/docs/instances/windows/automate-pw-generation)
- [Connect to Windows VMs using RDP](https://docs.cloud.google.com/compute/docs/instances/connecting-to-windows)
- [Windows Server image pricing](https://cloud.google.com/compute/disks-image-pricing)
- [GCP Spot VM behavior and premium OS pricing](https://docs.cloud.google.com/compute/docs/instances/spot)

## Definition of Done

Windows support is complete only when an allowlisted user can create a fully
priced Windows Server 2022 VM, connect by project SSH alias, use native RDP over
an SSH tunnel after one-time fresh-auth credential generation, survive
stop/start and Spot recovery with the same disk/address/DNS identity, and
delete every billable resource without opening GCP Console. Production billing
must reconcile to GCP's compute and Windows license charges, public 3389 must
remain closed, and no reusable account/provider credential or Windows password
may appear in the guest or durable CoCalc telemetry/state.
