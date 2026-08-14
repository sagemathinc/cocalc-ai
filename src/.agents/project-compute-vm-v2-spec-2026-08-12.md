# Project Compute VM v2 Specification

Date: 2026-08-12

Status: implemented and deployed to staging; production is unchanged.

## Staging Implementation Record

The v2 schema, hub control plane, project integration, CLI, frontend, provider
adapters, billing, egress metering, and turn-scoped capability implementation
are deployed on staging. The current staging artifacts are:

- hub: `20260813T035248Z-9618fb60-20260813T035223Z-9618fb60-nebius-home-9618fb60`;
- project: `20260813T010410Z-8c25e5e7-vm-v2-ssh-default-8c25e5e7`; and
- static: `20260813T035511Z-9618fb60-20260813T035223Z-9618fb60-nebius-home-9618fb60`.

Live staging validation completed the GCP x86-64 and T2A ARM64 lifecycles,
stable address and DNS behavior, project SSH configuration, the `user` and
`/home/user` guest contract, public TCP 443, Docker, unprivileged FUSE,
persistent-home replacement and online growth, all funding-lane authorization
paths, project-credential denial, egress measurement, explicit stop/restart,
deletion, and provider-orphan cleanup. Site-funded resources created no
customer purchases; temporary prepaid transitions closed their purchases.
Nebius storage-only authorization was also validated live by creating a 50 GB
replicated SSD home volume in `us-central1`: the durable logical size remained
50 GB while the provider and billing snapshot correctly recorded Nebius's
93 GB allocation unit. The detached test volume was then deleted successfully.
New guest bootstrap removes `/home/user/lost+found` only when that directory is
empty.

Two provider-capacity tests remain externally blocked rather than
implementation-blocked:

- GCP returned no Spot capacity in both tested zones, so retry behavior was
  observed but a real provider preemption could not be induced; and
- the configured Nebius tenant has consumed all three public IPv4 addresses,
  so CPU/GPU catalog and admission paths were tested but live instance
  creation cannot proceed until one address is safely freed or quota is
  raised.

Production rollout remains explicitly out of scope for this staging record.

Supersedes the product contract in
[Project Compute VM MVP Implementation Plan](./project-compute-vm-mvp-implementation-plan-2026-08-01.md).
The MVP document remains useful implementation history, but new work must follow
this specification.

## Executive Decision

Replace the managed-compute beta with a coherent VM v2 product. A managed VM
should feel like a larger, unrestricted CoCalc project machine rather than an
unrelated Ubuntu server:

- the login user is `user`;
- persistent user storage is mounted at `/home/user`;
- the attached CoCalc project's SSH key and `~/.ssh/config` work automatically;
- a running logical VM has a stable public IPv4 address and random stable DNS
  hostname across automatic Spot recovery;
- TCP ports 22 and 443 are public and clearly disclosed;
- GCP x86-64 and ARM64 machines are first-class choices;
- site-funded, account-postpaid, and account-prepaid funding exactly follow
  dedicated project-host policy;
- Codex turns can use narrowly scoped, expiring VM capabilities without an
  account session in the project;
- the project VM page shows useful egress quantity, cost, and recency; and
- GCP and Nebius, including Nebius GPUs, implement one provider-neutral managed
  VM contract.

This is a beta reset. There is currently one known VM, owned by the operator.
Preserve any wanted data, delete that VM and its provider resources, and deploy
the new schema and behavior without compatibility code. Do not support legacy
`ubuntu`, `/work`, ephemeral-running addresses, the two-value funding enum, or
old VM rows.

## Product Contract

A newly created managed VM has this conventional environment:

```text
SSH user:             user
Home directory:       /home/user
Persistent home:      optional independent grow-only volume
Public address:       stable while desired state is running
Public hostname:      stable for the logical VM lifetime
Public ingress:       TCP 22 and TCP 443
Administrative use:  passwordless sudo
Guest OS:             Ubuntu 24.04 LTS
```

The VM remains a hostile guest. It receives no cloud service account, CoCalc
database credential, Cloudflare token, provider credential, hub credential, or
account credential. CoCalc controls lifecycle externally. The guest has normal
root-equivalent control through passwordless `sudo`, so it can run Docker,
mount FUSE filesystems, replace system services, or crash itself.

## Goals

1. Remove recurring conceptual friction when moving between a CoCalc project
   and its VM.
2. Make Spot recovery transparent to SSH configuration and DNS clients.
3. Make the VM useful as a temporary HTTPS server without building a CoCalc
   application proxy.
4. Expose all eligible payment paths rather than silently choosing one.
5. Let an interactive agent perform explicitly approved VM work safely.
6. Add inexpensive ARM compute and practical GPU compute.
7. Keep lifecycle, spend, and cleanup durable under hub restarts, provider
   timeouts, and partial Cloudflare failures.

## Non-goals

- Custom DNS names or custom domains.
- CoCalc-managed TLS certificates or TLS termination.
- Public ports other than 22 and 443.
- A browser terminal, desktop, file browser, or Jupyter server on the VM.
- Automatic synchronization between project files and VM files.
- VM snapshots, image building, cloning, or cross-provider migration.
- Supporting old beta VM or volume rows.
- Giving ambient project credentials unrestricted account authority.
- Proxying SSH, HTTPS, file transfer, or agent workload traffic through a hub.

## Authority and Multibay Ownership

The existing architecture remains authoritative:

- the VM owner account's home bay owns VM, volume, funding, capability, and
  provider-work records;
- the attached project's owning bay owns project membership and project files;
- provider lifecycle work runs in the VM authority bay;
- project `~/.ssh/config` changes route through the project owning bay to its
  current project host;
- cross-bay operations use the inter-bay routing layer; and
- steady-state SSH and HTTPS traffic goes directly between the client and VM.

A project attachment does not transfer VM ownership. Only the owning account
can perform human lifecycle or funding actions. Authorizing the project's SSH
key intentionally grants data-plane SSH access to people and agents that can
use that private key from the project. The UI must state this consequence.

## Core Invariants

### Resource identity

- A logical VM ID, owner, attached project, and public hostname never change.
- Provider instance generations may change without changing logical identity.
- A public address is a separate provider resource with durable identity and
  reconciliation state.
- A DNS record is a separate Cloudflare resource with durable record ID and
  reconciliation state.
- A home volume has one owner, provider, location, filesystem, and funding
  mode, and can be attached read-write to at most one VM.
- Provider labels include logical VM ID, owner ID, environment, and resource
  role so inventory can recover after ambiguous operations.

### Failure safety

- Never repeat address, instance, disk, or DNS creation after a timeout without
  first inspecting durable IDs, provider labels, and records by hostname.
- Never mark a VM ready until the expected home filesystem and SSH keys are
  verified from an SSH probe.
- Never publish DNS before the address is attached to the intended VM.
- Never leave DNS pointing at a released address.
- Never release an address while desired state is running merely because a
  Spot instance was preempted.
- Never open a customer purchase session for a site-funded resource.
- Never trust guest-reported runtime, network use, or funding state.
- DNS failure must not destroy a healthy VM. It produces a visible degraded
  state and durable retry while direct-IP SSH remains available.

## Guest Identity and Bootstrap

### User

Every new VM uses exactly:

```text
username: user
home:     /home/user
shell:    /bin/bash
sudo:     passwordless
```

Do not retain an `ubuntu` compatibility login or emit commands that fall back
to `ubuntu`. Provider runtime defaults, CLI defaults, UI examples, tests, and
documentation all use `user`.

The idempotent guest bootstrap must:

1. create `user` and its primary group if absent;
2. assign a stable UID/GID selected by the image contract;
3. add `user` to the appropriate sudo group;
4. install a bounded `/etc/sudoers.d/cocalc-user` file;
5. set `/home/user` ownership and mode;
6. install only the VM's authorized public keys; and
7. write a bootstrap revision and ready sentinel.

The bootstrap must work on both Ubuntu 24.04 amd64 and arm64 images. It must be
safe on every boot and after a provider operation retry.

### Persistent home volume

Rename the product concept from **persistent `/work` volume** to **persistent
home volume**. Rename authoritative fields such as `attached_volume_id` to
`home_volume_id`; do not keep aliases for old API or UI terminology.

Without a home volume, `/home/user` lives on the persistent boot disk and
survives ordinary stop/start and Spot recovery. Deleting the VM deletes that
boot disk.

With a home volume:

- the independent grow-only ext4 volume mounts directly at `/home/user`;
- the volume survives VM deletion;
- the volume and VM must be in the same provider location;
- the volume can be attached to only one VM;
- changing attachment after VM creation remains deferred unless implemented
  as part of a separately tested lifecycle operation; and
- volume enlargement is detected and ext4 grows online.

Bootstrap the mount without a hidden-home failure mode:

1. wait for the expected provider device by stable provider disk ID;
2. format only if no filesystem exists;
3. mount first at a temporary path;
4. initialize `/etc/skel` and any required SSH files only when the filesystem
   is new;
5. enforce the stable UID/GID recursively only for the new filesystem, not on
   every boot;
6. add an idempotent UUID-based `/etc/fstab` entry for `/home/user`;
7. mount `/home/user`;
8. install current authorized keys after the mount; and
9. start the online-grow timer and write the ready sentinel.

The readiness probe must run a command over SSH that verifies:

```bash
test "$(id -un)" = user
test "$HOME" = /home/user
test -f /run/cocalc-managed-vm/bootstrap-ready
```

For an attached home volume it must additionally verify the expected block
device backs `/home/user`. If mounting fails, the VM remains `starting` or
`failed`; it must not become ready with writes landing on a hidden boot-disk
directory.

## SSH Integration

### Project key authorization

VM creation defaults to the attached project's deploy key when one exists. If
the project has no key, the create flow can generate it using the existing
project-to-project SSH mechanism. The user can instead choose an account SSH
key, but automatic project SSH configuration is enabled only when the exact
project public key is among the VM's authorized keys.

Additional keys continue to be normalized, size-limited, audited, and written
through provider metadata. Private keys never leave the project or user's own
machine.

### Managed project SSH config

When a VM reaches `ready` and authorizes the project key, enqueue a durable
`sync_project_ssh_config` action. Route it to a narrow project-host RPC that
atomically updates `~/.ssh/config` using managed markers. Reuse and generalize
the existing project-to-project SSH config parser rather than implementing a
second parser.

Use the exact VM name as the stable alias. VM names are already restricted to
safe SSH host tokens and should be unique within the attached project:

```text
<vm-name>
```

Example block:

```sshconfig
# >>> cocalc managed vm 12345678 >>>
Host build
  HostName vm-0123456789abcdef0123456789abcdef.cocalc.ai
  User user
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  ServerAliveInterval 15
  ServerAliveCountMax 2
  BatchMode yes
  PreferredAuthentications publickey
  PasswordAuthentication no
  KbdInteractiveAuthentication no
# <<< cocalc managed vm 12345678 <<<
```

The writer must:

- preserve all content outside its exact VM marker block;
- use compare-and-swap or an atomic project-host file mutation;
- create `~/.ssh` with mode 0700 and config with mode 0600;
- fail clearly rather than create ambiguous configuration if content outside
  the VM's managed marker block already defines the same exact `Host` alias;
- retry project-host unavailability durably;
- remove the block after intentional stop or VM deletion;
- retain the block during automatic Spot recovery; and
- restore the block when a stopped VM becomes ready again.

The UI and CLI display both the alias and direct command:

```bash
ssh build
ssh user@vm-0123456789abcdef0123456789abcdef.cocalc.ai
```

## Stable Public Address Lifecycle

### Cost

GCP currently charges the same amount for a static and ephemeral IPv4 address
while attached to a VM:

- Spot/preemptible: $0.0025/hour, approximately $1.83 per continuous month;
- Standard: $0.005/hour, approximately $3.65 per continuous month.

An unassigned reserved static address costs $0.01/hour. Therefore v2 keeps an
address assigned only while the VM's desired state is running or recovering,
and releases it for intentional stopped state.

### GCP lifecycle

Before creating or intentionally starting a GCP VM:

1. ensure a regional static external IPv4 address labeled for the logical VM;
2. persist its provider resource ID and address before instance mutation;
3. attach that exact address to the instance's Standard Tier access config;
4. verify the observed NAT IP and address association; and
5. reconcile DNS.

During automatic Spot preemption, rapid retry, or authorized Standard fallback:

- keep the address resource associated with the provider instance;
- keep the DNS record;
- restart or mutate the same provider instance when possible; and
- do not rewrite project SSH configuration merely because the generation
  restarted.

During an explicit user stop, funding-enforcement stop, or any other
control-plane transition to desired state `stopped`:

1. stop the instance;
2. remove its external access config;
3. delete the Cloudflare A record;
4. release the static address;
5. clear current `public_ip` while preserving `public_hostname`; and
6. remove the managed project SSH config block.

Deletion performs the same network cleanup before deleting instance and disk
resources. Every step is idempotent. Reconciliation discovers and removes
orphan addresses labeled for deleted logical VMs after a conservative grace
period.

### Provider-neutral requirement

Nebius must implement equivalent semantics using its public IP resource:

- stable during running and automatic recovery;
- released on intentional stop or delete;
- provider resource identity persisted before attachment; and
- orphan inventory and cleanup supported.

## Cloudflare DNS

### Name allocation

Allocate one random hostname when the logical VM row is created:

```text
vm-<32 lowercase hex characters>.<configured site DNS hostname>
```

Examples:

```text
vm-0123456789abcdef0123456789abcdef.cocalc.ai
vm-fedcba9876543210fedcba9876543210.staging.cocalc.ai
```

Use `randomBytes(16)` for 128 bits of entropy. The hostname is deliberately not
user-customizable. Store it in an authoritative `public_hostname` column with
a uniqueness constraint. Retry allocation on the vanishingly unlikely
collision.

### Record behavior

Create a Cloudflare **DNS-only** A record:

```text
type:     A
name:     durable random VM hostname
content:  current static public IPv4
proxied:  false
ttl:      120 seconds or Cloudflare's minimum supported DNS-only TTL
```

The record must not be orange-cloud proxied. A proxied record would prevent
ordinary SSH on port 22 and would turn HTTPS into a Cloudflare application
proxy, contrary to the direct data-plane contract.

Add a generic `ensureUnproxiedAddressDns` helper beside the existing Cloudflare
DNS helpers. It must:

- update by stored record ID when possible;
- recover from a stale record ID by looking up the exact hostname;
- adopt one matching A record only when its ownership is proven by the VM row;
- remove duplicate conflicting A/AAAA/CNAME route records;
- verify `proxied=false` and exact content;
- return the durable Cloudflare record ID; and
- never expose the Cloudflare token outside the trusted server process.

DNS reconciliation is independent durable work. Persist `dns_record_id`,
`dns_state`, `dns_updated_at`, and bounded `dns_error`. Readiness may complete
with DNS degraded if direct-IP SSH works, but the UI must show the degradation
and the worker must continue retrying.

On intentional stop, delete the record and clear `dns_record_id`, but retain
`public_hostname`. On restart, create a new record for the same hostname and
new address. On logical VM deletion, permanently release the hostname after
record deletion; the label is never intentionally reused.

### HTTPS expectations

Cloudflare supplies DNS only. CoCalc does not terminate TLS and does not place a
certificate or private key on the VM. The random hostname makes it practical
to configure a service on port 443, including `cocalc-start`, but the user is
responsible for the service and certificate. The UI must not claim that HTTPS
is healthy merely because DNS and port 443 exist.

## Network Security

Every managed VM exposes exactly these public ingress rules by default:

```text
TCP 22   SSH
TCP 443  HTTPS or another user-managed TLS service
```

For GCP, create separate idempotent managed firewall rules for SSH and HTTPS,
both scoped to the dedicated managed-VM network tag and source `0.0.0.0/0`.
Update existing rules when their definitions drift; setup must not merely skip
rules that already exist.

The provider security assertion must verify:

- TCP 22 and 443 ingress are present on the expected network and tag;
- no cloud service account is attached;
- project-wide cloud SSH keys are blocked;
- IP forwarding and deletion protection are disabled;
- external IPv6 is disabled until separately secured and metered;
- the VM is on the expected dedicated subnetwork;
- private/link-local egress denial and metadata exceptions remain correct; and
- the public interface uses the expected address and network tier.

Nebius security groups must express the equivalent policy. Provider setup and
inventory must identify drift before new creation and report existing drift as
an operator alert.

The VM page always shows:

```text
Public Internet: SSH 22 and HTTPS 443
```

It also warns that anything listening on those ports is reachable from the
Internet and that CoCalc does not authenticate the user's HTTPS application.

## Architecture and Machine Selection

### GCP

The backend already supports `t2a-standard-*`, `arm64`, and Ubuntu 24.04 ARM.
Make architecture explicit in the create flow before location selection:

```text
Provider -> CPU architecture -> Region -> Zone -> Machine
```

Supported initial architecture choices:

- `x86_64`: existing supported CPU-only GCP machine families plus the frozen
  G2/L4 GPU lane;
- `arm64`: `t2a-standard-1`, `t2a-standard-2`, ..., through provider catalog
  availability.

Filter regions and zones to those that actually contain a compatible machine.
Do not require users to discover a T2A zone before T2A appears. Permit the 4 GB
`t2a-standard-1` for managed VMs even if dedicated project hosts retain an 8 GB
minimum. Price and image compatibility are required before an option is
selectable.

For the initial GCP GPU lane, selecting `nvidia-l4` restricts machines to the
catalog's `g2-standard-*` types and restricts regions and zones accordingly.
G2 has a fixed integrated L4 topology, so GPU count is derived from the machine
shape rather than entered by the user: 1 for `g2-standard-4/8/12/16/32`, 2 for
`g2-standard-24`, 4 for `g2-standard-48`, and 8 for `g2-standard-96`. Use the
current Ubuntu accelerator image and enforce G2's 40 GB minimum boot disk. A
CPU-only machine and a selected GPU must never coexist in a submitted form.

The CLI exposes the same live source of truth with `cocalc vm catalog` and
`cocalc vm catalog --provider gcp|nebius`. Account sessions and turn-scoped
compute agents may query it; ambient collaborative project credentials may not.

Architecture detection must use catalog/provider metadata or an explicit
machine-family map. Do not use the current heuristic that assumes a family is
ARM merely because its prefix ends in `a`.

### Nebius and GPUs

The repository already contains a Nebius provider, catalog, pricing parser,
GPU choices, preemptible support, and disk lifecycle used by project hosts.
Managed compute must consume those implementations through the provider
adapter rather than duplicate their APIs.

The Nebius create flow is:

```text
Provider -> Region -> CPU/GPU class -> Instance type -> Image -> Storage
```

Initial Nebius scope includes:

- CPU-only instances supported by the existing catalog;
- available NVIDIA GPU instance types, including preemptible choices when the
  selected type supports them;
- compatible stock Ubuntu images;
- one boot disk and optional persistent home volume;
- stable public IP and random Cloudflare DNS;
- public TCP 22 and 443;
- the same `user` and `/home/user` contract;
- the same funding lanes, TTL, fresh-auth, and agent capability policy; and
- free customer egress pricing when current provider pricing says networking
  egress is free.

Nebius volume increments and effective billed size must be shown before
creation. GPU creation always shows hourly price, maximum TTL exposure, and
whether the selected capacity is preemptible.

## Provider-neutral Managed VM Adapter

Replace GCP-only unions and branches with a narrow server-side adapter. The
adapter is not exposed directly to clients.

Conceptual interface:

```ts
interface ManagedComputeProvider {
  id: "gcp" | "nebius";
  getCatalog(...): Promise<ManagedComputeCatalog>;
  estimateRates(...): Promise<ManagedComputeRateSnapshot>;
  ensurePublicAddress(...): Promise<ObservedPublicAddress>;
  releasePublicAddress(...): Promise<void>;
  ensureHomeVolume(...): Promise<ObservedVolume>;
  resizeHomeVolume(...): Promise<ObservedVolume>;
  inspectHomeVolume(...): Promise<ObservedVolume | undefined>;
  deleteHomeVolume(...): Promise<void>;
  createVm(...): Promise<ObservedVm>;
  startVm(...): Promise<ObservedVm>;
  stopVm(...): Promise<ObservedVm>;
  deleteVm(...): Promise<void>;
  inspectVm(...): Promise<ObservedVm | undefined>;
  setPricingModel(...): Promise<void>;
  ensureSshKeys(...): Promise<void>;
  inspectInventory(...): Promise<ManagedComputeInventory>;
  assertSecurity(...): Promise<void>;
  readPublicEgress(...): Promise<ObservedEgress | undefined>;
}
```

Provider operations return normalized observations plus opaque provider
metadata. Durable resource identity, desired state, funding, audit, retries,
and DNS remain in the common compute worker.

Do not force Nebius into GCP's zone or machine-type vocabulary. Common records
store normalized `region`, optional `zone`, architecture, CPU, RAM, GPU count,
and display machine name; provider-specific immutable selection remains in a
bounded provider-spec JSON object.

## Funding Lanes

Managed VMs and home volumes support exactly the dedicated-host funding modes:

```ts
type ManagedComputeFundingMode =
  | "site-funded"
  | "account-postpaid"
  | "account-prepaid";
```

Store `funding_mode` as an authoritative column on both VM and volume rows,
not only inside metadata.

### Eligibility

- `site-funded` is visible and accepted only when the owner is a site admin.
- `account-postpaid` is visible only when membership limits, payment method,
  automatic billing, second factor, and usage windows permit it.
- `account-prepaid` is visible only when membership limits, balance, second
  factor, and usage windows permit it.
- The API validates eligibility regardless of what the UI displayed.
- Create, start, resize, funding-mode change, and expensive agent grants use
  the existing dedicated-host admission snapshot at the account home bay.

`getCatalog` returns eligible funding modes, default mode, and concise disabled
reasons using the same policy source as project hosts. Reuse the project-host
funding selector component and wording.

### Accounting

For prepaid and postpaid modes, reuse dedicated-host purchase-session and
enforcement machinery with the selected lane. Compute, boot disk, public IP,
home volume, and billable egress have explicit price breakdowns.

For site-funded mode:

- do not open or update a customer purchase;
- do record provider cost and usage in the internal site-funded ledger;
- retain owner, project, provider, location, VM, and volume attribution;
- do not run prepaid/postpaid balance enforcement; and
- still enforce site aggregate quotas, emergency stops, TTL, and abuse policy.

Funding mode can be changed using the same transition rules as project hosts.
A running transition closes the old customer-funded purchase interval before
opening the new one, or closes it without replacement when moving to
site-funded. Every change requires fresh authorization and an audit event.

Volumes retain their own funding mode after VM deletion. A site-funded volume
whose owner is no longer eligible follows the same reviewed grace and cleanup
policy as site-funded project-host storage; it must not silently become a
customer charge.

## Agent and Codex Authority

### Problem

Ambient project credentials are intentionally project-scoped. They must not
become a permanent account session merely so Codex can create or delete VMs.
Conversely, an interactive turn needs a practical way to list, start, use, and
when approved create or remove attached VMs.

### Turn capability

Add an expiring managed-compute capability issued for one account, project,
browser-authorized turn, and funding envelope. Store only a hash of the bearer
secret. The plaintext capability is delivered to the trusted ACP worker for
that turn and is never written into the collaborative project filesystem,
terminal environment initialization, chat record, or VM.

Minimum durable fields:

```text
grant_id
secret_hash
owner_account_id
project_id
turn_id
session_id
issued_by_account_id
allowed_actions
allowed_vm_ids
allow_create
allowed_providers
allowed_machine_classes
funding_mode
max_active_vms
max_hourly_usd
max_total_authorized_usd
max_ttl_minutes
expires_at
revoked_at
created_at
last_used_at
```

Action classes are explicit:

- read: list, get, wait, inspect egress;
- data plane: ssh, exec, cp, rsync;
- availability: start and stop;
- billable creation: create VM or home volume, resize volume;
- destructive: delete VM or volume; and
- network publication: no separate action in v2 because DNS and ports are a
  fixed part of VM lifecycle.

The user-facing turn approval defaults to using existing attached VMs. Start,
create, resize, funding selection, and delete require explicit grant scope and
a bounded spend envelope. Issuing a grant with billable or destructive actions
requires the same browser-backed fresh authentication as doing the action
manually.

The `cocalc vm` CLI detects the turn capability before ambient project
credentials, calls the project-scoped compute gateway, and lets the authority
bay validate the grant. It does not run `auth login`, persist a CLI account
profile, or copy cookies into the project.

Every capability use records account, project, turn, grant, logical VM,
action, requested cost, result, and source worker. Revocation and expiration
take effect before new provider mutations. Existing SSH processes are not
forcibly proxied or terminated; stopping/deleting the VM remains the external
revocation boundary for established data-plane sessions.

## Egress Product and UI

The current UI has a compact cumulative value, but v2 makes egress visible and
actionable. Each VM row shows:

```text
This month:  12.4 MB / $0.00
Updated:     3 minutes ago
Provider:    GCP, $0.10/GB customer rate
```

The details popover shows:

- current calendar-month bytes and charge;
- lifetime bytes and charge;
- unit price or `Free`;
- last complete provider interval;
- metering delay; and
- a link to filtered Purchases when customer-funded.

Read these aggregates from the authoritative metering ledger, with row metadata
only as a cache. Preserve the existing five-minute finalization/watermark logic
and show stale/error state rather than pretending zero use.

For Nebius, show `Network egress: free` when the current pricing catalog and
site policy both say it is free. If provider byte metrics are available, show
quantity for information without recording a customer charge. A future
provider pricing change must flow through a new immutable price snapshot; it
must not retroactively reinterpret old free intervals.

## API and CLI Contract

### API model

Replace GCP-only public types with provider-neutral types. Important VM fields
include:

```text
provider
region
zone?
architecture
machine_type
cpu
ram_gb
gpu_type?
gpu_count
funding_mode
home_volume_id?
ssh_user
public_address_id?
public_ip?
public_hostname
dns_record_id?
dns_state
public_ports: [22, 443]
egress_summary
provider_spec
```

Do not expose provider credentials, raw operation responses, SSH public key
material not needed by the caller, Cloudflare record details beyond health, or
capability secret hashes.

### CLI examples

```bash
# GCP ARM Spot VM with a persistent home.
cocalc vm create build-arm \
  --project "$COCALC_PROJECT_ID" \
  --provider gcp \
  --arch arm64 \
  --zone us-central1-a \
  --machine t2a-standard-8 \
  --spot \
  --allow-standard-fallback \
  --home-volume build-home \
  --funding-mode account-prepaid

# Nebius GPU VM.
cocalc vm create gpu \
  --project "$COCALC_PROJECT_ID" \
  --provider nebius \
  --region eu-north1 \
  --machine <catalog-gpu-instance> \
  --ttl 8h \
  --funding-mode account-postpaid

cocalc vm list
cocalc vm ssh build-arm
cocalc vm exec build-arm -- bash -lc 'cd /home/user && docker ps'
```

Remove `/work` wording and examples. `vm ssh`, `exec`, `cp`, and `rsync` use
`user` and the stable hostname by default, with current IP fallback while DNS
is degraded. JSON output includes both.

## Project VM Page

The page should communicate the ordinary workflow rather than cloud internals.

### Create dialog order

1. Name.
2. Funding source, showing only eligible lanes.
3. Provider.
4. Architecture or CPU/GPU class.
5. Region and provider location.
6. Machine, sortable by price and performance/value where available.
7. Spot/Standard and fallback policy.
8. Persistent home choice and effective storage price.
9. Project SSH authorization.
10. Optional deletion deadline.
11. Complete hourly, stopped-storage, address, maximum-TTL, and egress summary.

### VM list

Show:

- name, provider, state, recovery status, and stable alias;
- architecture, CPU/RAM/GPU, region/location, and machine type;
- funding lane;
- Spot/Standard state and hourly price;
- public hostname and current IP;
- `SSH 22` and `HTTPS 443` public badges;
- home storage size and persistence;
- current-month egress quantity/cost and update recency;
- expiration; and
- connect, start/stop, create-similar, and delete actions.

The help text says that the machine is an unrestricted Internet-facing Ubuntu
VM, CoCalc is not installed unless the user installs it, `/home/user` is the
working home, and a home volume survives VM deletion.

## Durable State and Schema

This is a reset, so use clear columns instead of preserving metadata aliases.

### `compute_vms`

Add or normalize authoritative columns for:

- provider (`gcp` or `nebius`);
- nullable zone and normalized region;
- architecture, CPU, RAM, GPU type/count, and provider spec;
- funding mode;
- home volume ID;
- SSH user, fixed to `user` for v2;
- public address provider ID, state, current IP, and timestamps;
- immutable public hostname;
- Cloudflare DNS record ID, state, timestamps, and bounded error;
- bootstrap revision and observed bootstrap revision;
- fixed public port policy revision; and
- pricing snapshots for running, stopped, address, storage, and egress.

### `compute_volumes`

Normalize fields for provider, location, role=`home`, funding mode, requested
size, effective billed size, filesystem, stable provider ID, attachment fence,
and pricing snapshot.

### `compute_vm_instances`

Keep append-oriented provider generation history, including provider instance
ID, address ID/IP, pricing model, start/stop times, observed termination reason,
and security/bootstrap observations.

### `compute_vm_turn_grants`

Add the capability table described above with indexes on secret hash, turn,
project, account, expiration, and revocation.

### Durable work

Common work actions include:

```text
ensure_public_address
provision
start
verify_bootstrap
ensure_dns
sync_project_ssh_config
stop
release_dns
release_public_address
delete
reconcile
meter_egress
```

Serialize provider-mutating work per logical resource while allowing DNS and
project-config retries to make progress independently when safe.

## Reconciliation and Orphan Cleanup

Each provider inventory pass reconciles instances, boot disks, home volumes,
and public address resources. Cloudflare reconciliation separately inspects
records by stored ID and exact hostname.

Alert on:

- running VM without its expected static address;
- address attached to the wrong instance;
- duplicate or proxied VM DNS records;
- DNS pointing at an address not owned by the logical VM;
- released address with a remaining DNS record;
- ready VM whose guest bootstrap revision is stale;
- attached home volume not mounted at `/home/user`;
- invalid public firewall/security-group policy;
- site-funded resource with a customer purchase session;
- customer-funded resource without a valid purchase/enforcement state;
- grant use after expiration/revocation; and
- egress metering lag beyond the expected watermark.

Orphan deletion rules:

- stop unknown labeled VMs promptly, then require a conservative observation
  period before deletion;
- delete orphan static addresses and DNS records only after proving the owning
  logical resource is deleted or absent across repeated inventory passes;
- never automatically delete an unknown persistent home volume; and
- provide an audited operator command to inspect and resolve every orphan type.

## Security and Abuse Review

Before production, explicitly test:

- project collaborators understand that authorizing the project key grants VM
  SSH access;
- no project key from another project is accepted;
- VM ownership and funding mutations route to the account home bay;
- project credentials alone cannot create, resize, start, stop, or delete;
- agent grants cannot cross project, account, turn, provider, action, spend, or
  expiry boundaries;
- capability secrets do not appear in chat, logs, project files, command
  output, or provider metadata;
- site-funded mode is rejected for non-admins at every mutation boundary;
- port 443 does not accidentally open other ports or private ingress;
- direct DNS does not imply CoCalc authentication or TLS;
- provider metadata cannot expose cloud credentials;
- private/link-local egress protections remain intact;
- SSH keys are installed only for `user`;
- address/DNS retries cannot hijack an existing unrelated record; and
- deletion and funding enforcement cannot leak billable addresses.

## Tests

### Unit and package tests

- random hostname format, entropy source, collision retry, and immutability;
- DNS-only A record create/update/adopt/delete and duplicate cleanup;
- static address state transitions for create, Spot recovery, stop, restart,
  and delete;
- provider adapters normalize GCP and Nebius observations;
- architecture selection filters compatible location and image combinations;
- T2A including `t2a-standard-1` is selectable where available;
- guest bootstrap scripts are idempotent for amd64/arm64, with and without a
  home volume;
- readiness rejects hidden or incorrect `/home/user` mounts;
- SSH config managed-block insert/update/remove preserves unrelated text;
- all three funding lanes pass/fail exactly like project hosts;
- site-funded accounting never creates a customer purchase;
- egress summaries handle zero, stale, delayed, free, and failed metering;
- capability scope, expiry, revocation, action, and spend enforcement; and
- no public API or CLI retains `ubuntu` or `/work` defaults.

### Staging live tests: GCP

1. Reset the current beta VM inventory.
2. Create x86-64 and T2A VMs with project keys.
3. Verify `ssh <managed-alias>`, `whoami=user`, passwordless sudo, Docker, and
   FUSE operation.
4. Verify the random hostname resolves directly to the observed static IP.
5. Serve a test TLS endpoint on 443 and verify direct reachability.
6. Simulate/provider-trigger Spot termination and prove IP, hostname, and SSH
   config remain unchanged after recovery.
7. Explicitly stop and prove DNS record and static address are gone.
8. Restart and prove the same hostname maps to the new address and SSH config
   returns.
9. Create a home volume, write data in `/home/user`, resize online, stop/start,
   delete/recreate the VM around the retained volume, and verify data.
10. Exercise prepaid, postpaid, and admin-only site-funded modes and transitions.
11. Run egress, wait for finalization, and verify VM page and Purchases totals.
12. Exercise a Codex turn grant for existing use, creation, stop, and deletion;
    verify denial after revocation and expiration.
13. Inject provider and Cloudflare timeouts at every mutation boundary and
    prove convergence without duplicate or leaked resources.

### Staging live tests: Nebius

1. Create CPU and available GPU instances.
2. Verify the same user/home/SSH/DNS/port contract.
3. Verify preemptible recovery where supported.
4. Verify home-volume effective size and persistence.
5. Verify provider security group and credential isolation.
6. Verify free egress is displayed and does not create a metered purchase.
7. Repeat timeout, stop/restart, delete, and orphan inventory tests.

### Multibay tests

- owner home bay differs from project owning bay;
- project moves bays while VM remains attached;
- account rehoming is rejected or handled by an explicit operator procedure;
- project host replacement while SSH config sync is pending;
- home-bay hub rolling restart during provider and DNS work; and
- project deletion cleans VM lifecycle/config while retaining independently
  owned home storage according to policy.

## Observability

Record structured durations and outcomes for:

- admission and fresh auth;
- address ensure/release;
- provider create/start/stop/delete;
- bootstrap and SSH readiness;
- DNS ensure/delete/propagation probe;
- project SSH config convergence;
- Spot interruption and recovery;
- funding-session transitions;
- egress meter watermark; and
- agent grant issuance and use.

Health views show counts and oldest age for requested, provisioning, starting,
recovering, stopping, deleting, DNS-degraded, config-degraded, orphan-address,
and egress-stale resources. Alert separately on provider failure, Cloudflare
failure, guest-bootstrap failure, and funding enforcement instead of collapsing
them into one generic VM error.

## Implementation Order

### Phase 0: beta reset and schema cleanup

- Disable new VM creation briefly.
- Inventory the one known VM, its boot disk, optional `/work` volume, address,
  purchases, and egress intervals.
- Preserve anything the operator wants from it.
- Delete provider VM, boot disk, old volume if no longer needed, and logical
  beta rows; verify inventory is empty.
- Remove legacy API/types/UI/tests rather than migrate them.

### Phase 1: GCP v2 guest, address, DNS, and UI

- Implement `user`, `/home/user`, persistent home, bootstrap readiness, and
  managed project SSH config.
- Implement regional static address lifecycle and orphan cleanup.
- Implement DNS-only random Cloudflare hostnames.
- Open and validate ports 22 and 443.
- Fix architecture-first T2A selection.
- Update CLI, UI, docs, and egress presentation.
- Deploy to staging and complete the full GCP fault matrix.

### Phase 2: funding parity

- Add authoritative three-lane fields and API/UI eligibility.
- Implement site-funded internal accounting and no-purchase invariant.
- Test funding transitions and enforcement on VMs and retained home volumes.

### Phase 3: turn-scoped agent capability

- Add grant issuance, delivery, validation, audit, revocation, and CLI use.
- Test from real Codex turns without account profiles or project-persisted
  secrets.

### Phase 4: Nebius and GPU release

- Extract and enforce the provider adapter.
- Configure dedicated Nebius network/security/provider credentials.
- Add CPU/GPU catalog and image selection to the VM page.
- Complete Nebius lifecycle, storage, Spot, DNS, funding, egress, and orphan
  tests on staging.

### Phase 5: production canary and release

- Deploy schema/server/project image/static changes in dependency order.
- Enable only for admins, recreate the operator's VM, and dogfood every phase.
- Run automated daily create/use/preempt-or-restart/stop/release/delete canaries
  for both providers.
- Audit provider, address, DNS, disk, purchase, and grant inventories daily.
- Expand beyond admins only after at least one week without leaked resources,
  incorrect charges, or security invariant failures.

## Release Gates

The production release is blocked unless all of these are true:

- no legacy beta VM resources or compatibility code remain;
- GCP x86-64 and T2A live tests pass;
- `user` and `/home/user` are verified from an external SSH client;
- Spot recovery preserves address, hostname, and project SSH alias;
- intentional stop releases address and DNS without a leak;
- ports 22 and 443 are the only intended public ingress;
- all three funding lanes pass their accounting and authorization tests;
- project and agent credentials fail closed outside their scope;
- egress UI agrees with the authoritative ledger;
- Cloudflare outage degrades DNS without losing VM lifecycle control;
- orphan scans are clean after injected timeouts;
- Nebius CPU and at least one GPU lifecycle pass before Nebius is enabled; and
- rollback can disable creation and reconciliation mutations without deleting
  healthy persistent home volumes.

## Acceptance Criteria

The redesign is complete when an eligible user can:

1. create either a GCP x86-64/ARM VM or supported Nebius CPU/GPU VM using an
   eligible funding lane;
2. run `ssh <vm-name>` from the attached project without editing config;
3. land as `user` in `/home/user` with passwordless sudo;
4. persist and enlarge `/home/user` through an independent home volume;
5. survive Spot preemption without an IP, hostname, or SSH-config change;
6. intentionally stop the VM and observe its address and DNS record released;
7. restart it using the same hostname and a newly reconciled address;
8. serve a user-managed TLS application publicly on port 443;
9. understand current-month egress quantity, cost, and meter recency from the
   VM page; and
10. authorize one Codex turn to perform bounded VM work without placing an
    account credential in the project.
