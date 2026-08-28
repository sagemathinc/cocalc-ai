# Bay Security Maintenance and Hardening Plan

Date: 2026-08-28

Status: point-in-time production audit and proposed implementation plan. No
production mutation, package installation, service restart, firewall change,
or reboot was performed during this audit.

Classification: private and security-sensitive. Keep detailed host evidence,
cloud policy, identities, and incident data out of public documentation.

## 1. Executive Assessment

The production bay is healthy at the application layer, has strong current
backup evidence, and is not missing an immediately available Ubuntu security
package according to the current APT metadata. It is not, however, in an
acceptable long-term host-security posture.

The login warning is real. Production has been up since 2026-06-12 and is
running GCP kernel `6.17.0-1016`, while `6.17.0-1022` was installed on
2026-08-07. The reboot marker also includes `libc6`, and `needrestart` reports
that bay Postgres and peer-health need controlled restarts. Unattended upgrades
are installing security updates, but CoCalc correctly prevents them from
restarting control-plane services behind the operator's back. There is no
compensating controller that turns those deferred activations into bounded,
verified maintenance. The result is a three-week kernel activation lag and an
eleven-week uptime on a single production control-plane VM.

The more important structural finding is that all bay services run as the same
Unix user and all receive the same secret environment file. A remotely
exploitable hub-worker bug therefore does not need a root exploit to read the
database, alter mutable bay state, access unrelated service credentials, or
control the Cloudflare tunnel. Every audited bay unit received a
`systemd-analyze security` exposure score of `9.2 UNSAFE`.

The immediate decision package is:

1. Rehearse an exact staging VM reboot, then reboot production in the earliest
   controlled maintenance window. Do not wait for the full hardening program.
2. Attach Ubuntu Pro and enable Livepatch on staging, then the production bay,
   after the production host is running the current kernel.
3. Add a deterministic bay security-posture and maintenance controller. A
   reboot requirement must become a dated, externally visible operation, not a
   line in an interactive login banner.
4. Move production SSH behind IAP or an equally narrow administrative path,
   enable OS Login with strong authentication, and remove metadata-based and
   long-lived local access.
5. Split service identities and credentials, make deployed releases immutable
   to service processes, and incrementally harden each systemd unit.

## 2. Scope And Attacker Model

This is a host and control-plane audit. It does not repeat the application RPC,
authorization, billing, fresh-auth, abuse, or browser-security audits already
maintained elsewhere in `src/.agents`.

The bay has a different attacker model from a project host:

- A project host intentionally executes arbitrary customer code. Its primary
  risk is tenant escape into the host or another tenant.
- A bay should never execute customer code. Its primary risks are a remote hub
  exploit, an authenticated authorization bypass, a compromised project host
  abusing control-plane trust, stolen operator access, supply-chain compromise,
  cloud-identity theft, and compromise of Postgres or Conat state.
- Bay root compromise is control-plane catastrophic. The attacker can affect
  authentication, accounts, billing, project and host routing, secrets, and
  scoped project-host authorization. The direct browser-to-project-host data
  architecture limits routine data proxying through the bay, but the bay still
  has enough authority to cause broad impact.
- A single process compromise is currently close to a whole-bay compromise
  because every daemon shares one Unix identity and one broad secret file.

The security goal is therefore not project-style sandboxing. It is a minimal,
reproducible, tightly administered control-plane host with least-privilege
service identities, narrow network reachability, deterministic maintenance,
immutable artifacts, off-host evidence, and routinely proven recovery.

## 3. Point-In-Time Production Evidence

Evidence was collected read-only over SSH on 2026-08-28 UTC.

### 3.1 Controls Working Well

- Ubuntu 24.04 LTS is within standard support through 2029.
- `unattended-upgrades`, `apt-daily.timer`, and `apt-daily-upgrade.timer` are
  enabled and active.
- APT metadata was refreshed on 2026-08-28. Recent unattended runs installed
  OpenSSL, PAM, curl, PostgreSQL, and other security updates successfully.
- `pro security-status` found 613 installed Main/Restricted packages covered by
  standard security maintenance and only three Universe/Multiverse packages.
- The current list of 35 ordinary upgrades is from `noble-updates`; the audit
  did not identify a pending `noble-security` package. This does not prove that
  the running kernel contains every available fix.
- Password and keyboard-interactive SSH authentication are disabled.
- Public probes found the tested hub, Conat cluster, and peer-health ports
  blocked externally. Only SSH was reachable in the tested set.
- Postgres listens on loopback, and browser traffic enters through a local
  frontdoor and Cloudflare tunnel.
- Kernel baseline controls include ASLR, protected hardlinks/symlinks/FIFOs,
  restricted dmesg and kernel pointers, Yama ptrace scope, and restricted
  unprivileged BPF.
- AppArmor is loaded, NTP is synchronized, and no systemd unit was failed at
  the time of inspection.
- Local bay health passed for Postgres, persist, router, frontdoor, and all four
  hub workers.
- pgBackRest/WAL status was healthy with no failed archives or pending spool.
- The newest differential Postgres backup was less than ten hours old.
- Changed-only Conat SQLite backup completed successfully less than one hour
  before inspection.
- An isolated disposable GCP point-in-time recovery drill passed on
  2026-08-24. It verified Postgres PITR semantics, selected application tables,
  and `PRAGMA quick_check` on 134,852 restored Conat databases, then deleted the
  disposable worker.

These controls materially lower the risk of the proposed maintenance reboot.
They do not make a single-bay reboot or compromise harmless.

### 3.2 Maintenance Gaps

- Boot time: 2026-06-12.
- Running kernel: `6.17.0-1016-gcp`.
- Installed expected kernel: `6.17.0-1022-gcp`, installed 2026-08-07.
- `/var/run/reboot-required` is present and identifies successive kernel
  updates plus `libc6`.
- `needrestart` reports kernel state `3` and expects `6.17.0-1022-gcp`.
- `needrestart` reports at least bay Postgres and bay peer-health as needing a
  controlled restart.
- Ubuntu Pro is not attached and the Livepatch client is not installed.
- The GCP OS Config agent is running, but there is no evidence in this audit of
  an enforced CoCalc bay patch policy or reboot deadline.
- The existing `needrestart` rule deliberately suppresses automatic restarts of
  every `cocalc-bay-*` service. There is no paired maintenance timer or durable
  deferred-restart queue.

### 3.3 Privilege And Secret Gaps

- Postgres, hub workers, router, persist, frontdoor, cloudflared, peer-health,
  backups, and maintenance tools all run as `cocalc-bay`.
- Every service loads `/etc/cocalc/bay-secrets.env`, which contains database,
  cookie/session, Conat, cluster, pgBackRest, R2, and backup credentials.
- The same Unix identity owns database and Conat state, project-host signing
  material, backup credentials, Cloudflare tunnel credentials, and a mutable
  Cloudflare executable.
- Most services also receive the site master key through `LoadCredential`,
  whether or not their implementation has demonstrated that it needs it.
- Core dumps are not explicitly disabled for bay services. A crash dump can
  preserve secrets and sensitive process state.
- The actual units contain none of the audited systemd sandbox controls such as
  `NoNewPrivileges`, `ProtectSystem`, `ProtectHome`, `PrivateTmp`,
  `PrivateDevices`, capability bounds, namespace restrictions, syscall filters,
  or explicit read/write path allowlists.
- Release entrypoints and primary control-plane runtime are root-owned, which is
  good, but the release root and several runtime directories are writable by
  `cocalc-bay`. The deployment contract is not uniformly immutable.

### 3.4 Administrative And Network Gaps

- The VM has a public external IP and public TCP/22 was reachable.
- The audit counted 31,840 failed/invalid SSH authentication log entries during
  the previous 30 days. Password login is disabled, so this is primarily noise
  rather than evidence of compromise, but there is no reason to expose the
  control-plane SSH daemon to continuous Internet scanning.
- OS Login, project-key blocking, and OS Login security-key enforcement are
  unset.
- SSH permits root public-key login, TCP forwarding, agent forwarding, X11
  forwarding, TTYs, six authentication attempts, and ten sessions.
- Several legacy/local interactive accounts exist. Persistent authorized-key
  files are present for operator and service-style users.
- The host firewall is inactive. GCP policy blocked the tested non-SSH public
  sockets, but hub and Conat cluster processes bind some ports on all
  interfaces. Provider policy is the only observed packet-filter boundary.
- Secure Boot is disabled. UEFI is active, but vTPM and integrity-monitoring
  state could not be confirmed from the read-only host view.
- The VM uses the default Compute Engine service account. OAuth scopes are
  narrower than `cloud-platform`, but actual IAM bindings were not available
  because the local GCP credential required reauthentication. The effective IAM
  permissions remain an explicit audit item.

### 3.5 Detection, Inventory, And Supply-Chain Gaps

- `auditd` is absent, and no independent host integrity tool was found.
- Journald currently consumes 3.7 GB. The documented 1 GB/7-day bay policy is
  not present as an active journald drop-in on production.
- The audit did not establish durable off-host export of bay system/security
  logs or a dead-man signal independent of the bay.
- The host has 622 Debian packages, 54 enabled services, Snap, and a classic
  Google Cloud CLI snap. This is not an inherently unsafe count, but it is not
  a deliberately minimal control-plane image.
- Bay manifests identify release kind, git state, Node, and entrypoints, but do
  not provide a complete file inventory, cryptographic artifact digest,
  signature, SBOM, or verifiable provenance attestation.
- The release installer extracts artifacts and changes ownership without first
  verifying a trusted signature. Checksums used during transfer are useful for
  corruption detection but are not publisher authentication.

### 3.6 Availability Constraint

Production reports `cluster_role=standalone` with only `bay-0`. Four hub
workers improve process availability but Postgres, router, persist, frontdoor,
cloudflared, VM, zone, and operating system remain correlated failure domains.
There is no bay-level or Postgres failover target. Any kernel reboot is a short
whole-site maintenance event, and any failed boot is a potentially extended
outage.

This is a reason to rehearse and automate reboots, not a reason to defer them
indefinitely.

## 4. Immediate Production Maintenance

### 4.1 Recommendation

Schedule the production reboot in the earliest controlled low-traffic window,
ideally within 24-72 hours. The current kernel has lagged the installed kernel
for three weeks. Do not combine this narrow kernel activation with unrelated
service hardening, firewall migration, service-user splitting, or all 35
ordinary package upgrades.

No emergency assertion is justified solely from the evidence collected: APT
shows no pending security-origin packages, application health is green, and
there is no observed compromise. Conversely, the absence of Livepatch means we
cannot claim that the old running kernel has current live fixes. Continuing to
wait without a dated maintenance operation is not acceptable.

### 4.2 Preflight

1. Reboot staging from the same Ubuntu generation and bay systemd scaffold.
2. Before staging reboot, assert that the expected kernel is installed and the
   bootloader selects it.
3. Verify a cold boot starts Postgres, migrations, router, persist, peer-health,
   frontdoor, cloudflared, watchdog, backup timers, and all configured workers
   without SSH intervention.
4. Run `bay-health`, the public hub health probe, sign-in, project open/start,
   and a bounded Jupyter or terminal smoke on staging.
5. Record the current production release, previous release, kernel, boot ID,
   unit state, disk headroom, failed units, and active alerts.
6. Require fresh healthy pgBackRest/WAL and SQLite status. The 2026-08-24
   disposable PITR proof is recent enough, but run a new drill first if any
   backup or WAL signal has changed.
7. Confirm the newest installed kernel exists in `/boot` and that serial-console
   or provider recovery access is available.
8. Take a provider snapshot of the boot disk for configuration rollback. Do not
   treat a crash-consistent snapshot of live Postgres as a replacement for
   pgBackRest/PITR.
9. Announce a bounded maintenance window and freeze deploys, package work, and
   backup jobs during the reboot.
10. Ensure an external operator has the exact post-boot checks and rollback
    steps before the VM is touched.

### 4.3 Execution And Verification

1. Capture evidence before mutation.
2. Enter maintenance/drain mode through the existing frontdoor mechanism so
   new browser work receives an explicit bounded response.
3. Stop bay services cleanly or use the validated systemd shutdown ordering,
   then reboot once.
4. Set a hard recovery deadline. If the VM or public health is not returning on
   schedule, begin provider-console diagnosis rather than repeatedly rebooting.
5. Verify the running kernel is `6.17.0-1022-gcp` or newer and
   `/var/run/reboot-required` is absent or newly explained.
6. Verify no failed units and run `needrestart` again.
7. Require local bay health with all four workers, then public health, sign-in,
   project routing/start, and a real terminal or Jupyter operation.
8. Verify WAL archiving resumes, backup timers are scheduled, the backup mount
   remains a distinct filesystem, and no unexpected backup starts.
9. Inspect Cloudflare, SSH, Postgres, router, persist, and watchdog logs for the
   entire boot interval.
10. Close the maintenance operation only after independent public probes pass.

### 4.4 Recovery

- If the new kernel fails early, select the previous known-good kernel through
  the provider serial console or boot-disk repair workflow.
- If the OS boots but CoCalc fails, preserve diagnostics before using the
  versioned bay rollback command.
- If Postgres fails, do not initialize a new cluster or mutate the data
  directory. Diagnose mount, ownership, WAL, and unit ordering first.
- Use pgBackRest/PITR only for proven data corruption or unrecoverable database
  state, not as the first response to an ordinary service-ordering bug.
- A provider snapshot rollback must not silently roll Postgres behind current
  Conat or object-storage state. Restore paths require explicit fencing and
  authority decisions.

## 5. Deterministic Bay Maintenance Control

Adapt the project-host security updater into a shared host-security component
rather than maintaining two unrelated shell implementations.

### 5.1 Host-Local Units

Add root-owned units:

- `cocalc-bay-security-posture.service` and timer: read-only inventory, at least
  hourly plus at boot.
- `cocalc-bay-security-update.service`: explicit inventory/download/install
  modes, run only through an operator or maintenance controller.
- `cocalc-bay-maintenance.service`: a bounded state machine for controlled
  service restarts and reboot activation.
- `cocalc-bay-security-deadman.timer`: verifies posture freshness and reports
  loss externally; it does not reboot the bay.

The implementation should reuse the project-host work added around
`bootstrap.py`, runtime posture, boot ID binding, and security observations,
but extract the generic OS facts into a package/script shared by both roles.

### 5.2 Required Posture Record

Publish a versioned atomic record containing:

- environment, site, bay, provider, zone, VM generation, role, and report
  schema;
- timestamp, boot ID, boot time, uptime, and image identity;
- OS release, installed kernel, running kernel, reboot-required state,
  triggering packages, and first-observed time;
- APT metadata age, package-manager health, pending security and ordinary
  updates, last install success/failure, and held packages;
- `needrestart` kernel and service results;
- Ubuntu Pro entitlement/attachment, ESM, Livepatch status, and livepatched CVE
  evidence where supported;
- failed units, unexpected unit restarts, time synchronization, disk/inode
  headroom, memory pressure, and OOM evidence;
- firewall policy digest, effective listeners, SSH posture, OS Login posture,
  Secure Boot/vTPM/integrity state, service account identity, and approved IAM
  digest;
- release artifact digest, source revision, signature identity, SBOM digest,
  Node/Postgres/cloudflared/pgBackRest/Rustic versions, and managed-file
  integrity digest;
- systemd hardening profile/version for each bay unit;
- backup/WAL/restore-test freshness summaries without credentials;
- local observation and independent off-host receipt timestamps.

Store current posture in the operations UI and append immutable transitions to
the security evidence plane. Do not make the bay's own Postgres the only copy:
an unavailable or compromised bay must not erase its last posture or dead-man
event.

### 5.3 Maintenance States

Use explicit states:

| State                  | Meaning                                                   | Single-bay action                        |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------- |
| `compliant`            | Current report and enforced controls pass                 | Normal service                           |
| `grace`                | New update/restart condition within deadline              | Alert and schedule                       |
| `maintenance-required` | Deadline exceeded or activation needed                    | Page and require dated operation         |
| `quarantined`          | High-confidence compromise or critical integrity mismatch | Incident workflow; do not blindly reboot |
| `unknown`              | Missing, stale, or invalid evidence                       | Page; never label healthy                |

With one bay, posture automation must not automatically turn off the whole site
because a feed is unavailable. It should page and block new deployments or
replacement admission when appropriate. Once a second bay exists, a
noncompliant bay can be drained from ingress after capacity and authority
checks.

### 5.4 Suggested Deadlines

These are internal operational objectives, not customer SLAs:

- APT metadata and posture report: less than 24 hours old.
- Failed security-update attempt: page after the second bounded failure or six
  hours, whichever comes first.
- Known exploited or critical remotely relevant issue: mitigation or activation
  operation within 24 hours, with explicit exception evidence.
- High-severity relevant issue: seven days.
- Ordinary installed kernel awaiting reboot: 14 days maximum.
- Service restart required after a security library update: seven days, or
  sooner when the affected daemon is Internet/control-plane facing.
- Livepatch unsupported, warning, or stale: one day to investigate.

The policy engine must use relevance, exploitability, fix availability, and
actual inventory. Raw CVE counts are not sufficient.

### 5.5 Ubuntu Pro And GCP VM Manager

Use Ubuntu Pro on bays. The immediate value is Livepatch and machine-readable
coverage/posture; ESM Apps is less important today because production has only
three Universe/Multiverse packages and Ubuntu 24.04 Main remains in standard
support. Pro does not eliminate normal upgrades or reboots.

Canary order:

1. staging bay;
2. rebooted staging replacement;
3. production bay during an observed window;
4. future second bay and replacement image.

GCP VM Manager should provide independent inventory and validation-mode OS
policy evidence. Do not simultaneously let unattended-upgrades, a CoCalc
controller, and GCP patch jobs each mutate or reboot the VM. CoCalc owns
activation ordering; provider tooling is an independent observer and emergency
executor with narrowly granted IAM.

## 6. Service Isolation And Secrets

### 6.1 Split Identities

Create distinct system users and state ownership:

| Service       | User                     | Writable state                      | Credentials                                                       |
| ------------- | ------------------------ | ----------------------------------- | ----------------------------------------------------------------- |
| Postgres      | `cocalc-bay-postgres`    | Postgres data/socket/log only       | repository archive credential only if required by archive command |
| Conat persist | `cocalc-bay-persist`     | persist databases/catalog only      | Conat service credential, required encryption key                 |
| Conat router  | `cocalc-bay-router`      | bounded router state only           | cluster/router credential                                         |
| Hub workers   | `cocalc-bay-hub`         | bounded logs/cache/diagnostics only | cookie/session and application-specific credentials               |
| Frontdoor     | `cocalc-bay-frontdoor`   | drain/runtime state only            | no database/backup/cloud credential                               |
| Cloudflare    | `cocalc-bay-cloudflared` | tunnel runtime state only           | tunnel credential only                                            |
| Peer health   | `cocalc-bay-peer-health` | no durable state                    | peer-health credential only                                       |
| Backup        | `cocalc-bay-backup`      | backup mount/spool only             | pgBackRest/Rustic/R2 credentials only                             |
| Maintenance   | root oneshot             | managed OS/unit paths only          | no application/session secret                                     |

Postgres and Conat migration tools need deliberately designed one-shot access;
they must not be a reason to keep every long-running service in one group.

### 6.2 Credential Delivery

- Replace the global secret environment file with per-service
  `LoadCredential=` files or an equivalent root-mediated credential mechanism.
- Pass each process only the values it consumes.
- Do not expose secrets in command lines, world-readable environment files,
  generated manifests, journals, crash dumps, or support diagnostics.
- Disable core dumps for secret-bearing services and define a separate,
  explicit incident-only capture process.
- Rotate cluster, Conat, cookie/session, Cloudflare, backup, project-host signing,
  and site-master credentials independently where protocol compatibility allows.
- Record credential version and rotation time, never credential material, in
  posture.
- Make credential consumers restartable one role at a time; document which
  rotations invalidate sessions or cross-bay communication.

### 6.3 Immutable Release

- Extract releases into a root-owned staging directory.
- Verify a trusted signature and manifest before changing the `current`
  symlink.
- Make all executable/runtime files root-owned and non-writable by service
  users.
- Keep writable state outside `/opt/cocalc/bay/releases` in explicitly owned
  directories.
- Verify the release tree digest before start and periodically from a root-owned
  integrity service.
- Never execute cloudflared or another privileged control-plane dependency from
  a service-writable `secrets` directory.

## 7. Systemd Hardening

Do not paste one generic hardening block into every service. Add controls by
role, canary each one, and test backup/restore, migrations, Node workers,
Postgres, Cloudflare, and Conat explicitly.

Baseline candidates:

- `NoNewPrivileges=yes`
- `ProtectSystem=strict`
- `ProtectHome=yes`
- `PrivateTmp=yes`
- `PrivateDevices=yes`
- `ProtectKernelTunables=yes`
- `ProtectKernelModules=yes`
- `ProtectKernelLogs=yes`
- `ProtectControlGroups=yes`
- `ProtectClock=yes`
- `ProtectHostname=yes`
- `RestrictSUIDSGID=yes`
- `LockPersonality=yes`
- `RestrictRealtime=yes`
- `RemoveIPC=yes`
- `UMask=0077`
- `CapabilityBoundingSet=` with no capabilities unless demonstrated necessary
- explicit `ReadWritePaths`, `ReadOnlyPaths`, and `InaccessiblePaths`
- explicit `RestrictAddressFamilies`
- service-specific `SystemCallFilter`
- `LimitCORE=0`

Node/V8 JIT normally prevents `MemoryDenyWriteExecute=yes`; do not disable JIT
or add an unsafe exception merely to improve a score. Postgres, backup, and
cloudflared each require their own compatibility profile. The acceptance gate
is effective denied access plus passing workloads, not a particular numerical
`systemd-analyze` score.

Run systemd credentials and sandbox tests in CI using disposable VMs because
many controls cannot be validated faithfully in Jest or an unprivileged
container.

## 8. Administrative Access And Cloud Identity

### 8.1 SSH

Preferred end state:

- remove the bay public IP or remove public SSH ingress;
- connect through GCP IAP or a separately controlled bastion;
- enforce OS Login and organizational policy so instance metadata cannot turn
  it off;
- require security keys or equivalent phishing-resistant strong
  authentication;
- grant OS Login User/Admin per VM and for bounded time;
- remove project/instance metadata SSH keys and persistent local operator keys;
- set `PermitRootLogin no`;
- disable X11, agent, and TCP forwarding by default;
- allow a narrowly reviewed `Match` exception only when an operator workflow
  genuinely requires forwarding;
- retain one tested break-glass path with independent credentials, alerting,
  and quarterly exercise.

Do not install fail2ban as the primary answer to 31,840 Internet SSH probes.
Remove or narrow the public attack surface instead.

### 8.2 Cloud Service Account

- Replace the default Compute Engine service account with a dedicated bay
  identity.
- Enumerate actual IAM roles in `projecthosts`; OAuth scopes alone are not an
  authorization audit.
- Grant only the exact object read/write, logging, monitoring, and provider
  inspection actions the bay needs.
- Keep VM creation, IAM mutation, firewall mutation, OS policy mutation, and
  broad secret access out of the long-running bay identity.
- Give backup/restore, project-host provisioning, and emergency maintenance
  separate short-lived identities and audited operations.
- Alert on service-account, metadata, scope, IAM, and attached-disk drift.

GCP documents OS policy assignment management as remote-code-execution
authority. Treat its IAM as production root and separate policy viewer from
policy editor.

### 8.3 Boot And Disk Integrity

- Recreate/canary the bay with Shielded VM Secure Boot, vTPM, and integrity
  monitoring enabled.
- Verify the CoCalc kernel, agents, and release boot under Secure Boot before
  production rollout.
- Record integrity events off-host and page on unexpected changes.
- Verify Google-managed encryption or an approved CMEK policy for boot, data,
  and backup disks through cloud inventory. Local `lsblk` cannot establish the
  provider encryption policy.

## 9. Network Policy

Maintain defense in depth at provider and host layers.

1. Inventory every listener, client, source range, and protocol.
2. Bind local-only services to loopback.
3. Bind inter-bay or project-host control services only to the required private
   interface and require application authentication.
4. Remove direct public listeners when Cloudflare Tunnel is the intended
   ingress.
5. Apply a default-deny GCP ingress policy targeted by immutable labels/service
   accounts, not broad shared tags.
6. Apply an nftables host policy that independently permits only loopback,
   established traffic, IAP/bastion SSH, required private control traffic, and
   documented monitoring.
7. Restrict egress by service and destination where practical, especially
   metadata, cloud APIs, backup storage, package mirrors, email, and project
   hosts.
8. Block long-running unprivileged services from cloud metadata unless they
   explicitly need it. Proxy narrowly scoped metadata-derived operations
   through a root/provider agent where necessary.
9. Test public and private addresses. A public GCP probe is not evidence that a
   project host or another VPC peer cannot reach a wildcard listener.
10. Store provider and host policy digests in posture and fail replacement
    admission on stale or unknown policy.

Roll this out in staging with connection logging before enforcement. Router,
project-host bootstrap, backup, Cloudflare, and operator paths must be proven
before production deny rules activate.

## 10. Detection, Evidence, And Incident Readiness

- Install and configure `auditd` with bounded rules for authentication,
  sudo/privilege changes, unit and timer changes, `/etc/cocalc`, release
  activation, SSH configuration, firewall policy, kernel/module changes, and
  service-account/metadata tooling.
- Export security and service logs off-host with backpressure and disk bounds.
- Restore the documented journald 1 GB/7-day cap or update the documentation to
  an explicitly chosen measured limit.
- Add a root-owned managed-file baseline for units, sudoers, SSH configuration,
  update policy, release manifests, credential metadata, and executables.
- Keep the baseline and observations off-host. A local-only hash database is
  mutable by the attacker it is meant to detect.
- Detect loss of posture, audit/log export, time sync, Livepatch, OS Config,
  backup/WAL, Cloudflare, and external health dead-man signals.
- Correlate cloud audit logs for SSH/IAP, metadata, IAM, firewall, disk,
  snapshot, VM, OS policy, and service-account changes.
- Preserve bounded pre-restart diagnostics. Restarts must not erase the only
  incident evidence.
- Reuse the reliability plan's independent sentinel; do not create a separate
  security monitor that shares the same VM, database, and alert path.

Retain high-value security/control summaries according to CoCalc's audited
retention policy. The project-host plan's proposed 400-day critical-evidence
target is a reasonable common default if no stricter policy already exists.

## 11. Supply Chain And Minimal Image

### 11.1 Bay Artifact

The release pipeline should produce:

- content-addressed immutable bay artifact;
- complete file inventory and SHA-256 tree digest;
- SPDX or CycloneDX SBOM for Node packages, bundled binaries, and system
  dependencies;
- source revision, clean/dirty state, builder identity, build recipe, and build
  timestamp;
- SLSA-style provenance attestation;
- signature from a release identity not available to the bay VM;
- cloudflared, Node, Postgres tooling, pgBackRest, Rustic, and migration
  entrypoint versions/digests;
- promotion record from staging canary to production.

The bay verifies signature, expected environment, architecture, and digest
before activation. The independent evidence plane records desired and observed
digests.

### 11.2 OS Image

- Build a minimal versioned Ubuntu LTS bay image or deterministic image recipe.
- Remove packages and enabled services that are not required by a measured
  workflow.
- Pin and inventory external repositories and classic snaps.
- Scan exact installed inventory against Ubuntu advisories, OSV/GHSA where
  relevant, and CISA KEV.
- Rebuild replacement VMs regularly so production is not a unique 77-day-old
  pet whose boot path is rarely exercised.
- Exercise a clean replacement in staging and an idle production canary before
  treating replacement as the routine patch path.

## 12. Availability And Recovery

Security maintenance depends on reliability work already proposed in
`cocalc-ai-reliability-failure-mode-audit-2026-07-15.md`:

- independent sentinel and external paging;
- honest public health and scheduled user-path canary;
- durable maintenance loop heartbeats;
- routine disposable PITR drills;
- Postgres standby with fenced manual promotion;
- a second bay for public/control-plane failover.

Near-term, keep reboot automation human-approved because production is one
standalone bay. After a second bay and Postgres authority/fencing are proven,
maintenance should become:

1. verify destination capacity and security posture;
2. drain public ingress from one bay;
3. patch/reboot or replace it;
4. run local and external user-path probes;
5. return it to ingress only when compliant;
6. repeat for the other bay.

Do not implement automatic database promotion merely to make reboots look
seamless. A split-brain control plane is worse than a short planned outage.

## 13. Implementation Phases

### Phase 0: Current Production Correction

- Rehearse staging reboot and perform the controlled production reboot.
- Capture before/after kernel, boot, `needrestart`, health, backup, and public
  probe evidence.
- Canary Ubuntu Pro/Livepatch on staging.
- Add reboot-required and running-vs-installed kernel checks to the production
  health checklist immediately.
- Page when reboot age exceeds the temporary manual deadline.

### Phase 1: Posture And Maintenance Controller

- Extract generic OS posture logic from the project-host hardening work.
- Add bay posture/update/dead-man units and atomic JSON schema.
- Publish posture off-host and expose it through admin/CLI read paths.
- Add `cocalc bay security-status <bay>` and a dry-run maintenance command.
- Run observe-only for at least one update cycle.
- Attach Pro/Livepatch to production after staging evidence passes.

### Phase 2: Administrative And Network Surface

- Audit effective GCP IAM and firewall policy with refreshed cloud credentials.
- Move SSH to IAP/bastion, enable OS Login/security keys, and remove metadata
  keys and permissive forwarding defaults.
- Replace the default VM service account with a least-privilege bay identity.
- Add provider plus host firewall policy and listener conformance.
- Canary Secure Boot/vTPM/integrity monitoring on a replacement bay.

### Phase 3: Service Isolation

- Introduce per-service users, groups, directories, and credentials in staging.
- Move Postgres and Conat state ownership without broad group fallback.
- Make releases fully root-owned and immutable.
- Add systemd hardening role by role with compatibility tests.
- Rotate credentials after the old shared UID can no longer read them.
- Reboot staging and run backup/PITR plus full user-path tests.

### Phase 4: Supply Chain And Detection

- Sign bay artifacts and produce SBOM/provenance.
- Verify artifacts before activation and continuously verify managed files.
- Add auditd, off-host logs, cloud audit correlation, and external dead-man.
- Build the minimal reproducible bay image and replacement drill.

### Phase 5: Routine Rolling Maintenance

- Add one-bay-at-a-time drain/patch/reboot/verify after a second bay exists.
- Add Postgres standby and fenced manual promotion drills.
- Permit bounded automatic maintenance only after repeated staging and
  production-canary success.

## 14. Code Map

Primary implementation targets:

- `src/scripts/bay-systemd/bay-bootstrap-host.sh`
- `src/scripts/bay-systemd/bay-bootstrap-release.sh`
- `src/scripts/bay-systemd/install-scaffold.sh`
- `src/scripts/bay-systemd/needrestart/cocalc-bay.conf`
- `src/scripts/bay-systemd/systemd/cocalc-bay-*.service`
- `src/scripts/bay-systemd/bin/bay-health`
- `src/scripts/bay-systemd/bin/bay-preflight`
- `src/scripts/bay-systemd/bin/bay-rollout-full`
- `src/scripts/bay-systemd/bin/bay-status`
- new `src/scripts/bay-systemd/bin/bay-security-posture`
- new `src/scripts/bay-systemd/bin/bay-security-update`
- new posture/update/dead-man systemd units and timers
- `src/packages/cli/src/bin/commands/bay.ts`
- a bay security-posture schema/read path in `src/packages/util`,
  `src/packages/database`, and `src/packages/server`
- the project-host hardening branch's generic security updater/posture logic,
  extracted from `src/packages/server/cloud/bootstrap/bootstrap.py` and
  `src/packages/project-host/runtime-posture.ts`

Keep bay authority explicit. The bay owns its local operating state, while an
independent global/security plane stores observations and policy. Do not route
steady-state project data through the hub to implement this control.

## 15. Validation Matrix

### Automated

- posture parser fixtures for healthy, stale, reboot-required, Pro detached,
  Livepatch warning, package-manager failure, failed unit, and missing report;
- boot ID mismatch invalidates a pre-reboot success report;
- atomic status write and bounded lock/timeout behavior;
- update dry-run never mutates packages or services;
- `needrestart` reason parsing and first-observed timestamp persistence;
- per-service credential tests prove unrelated secrets are absent from
  `/proc/<pid>/environ`;
- release service users cannot modify executables or manifests;
- systemd sandbox tests prove denied filesystem/device/kernel access;
- firewall/listener tests prove each documented allow and seeded deny;
- SSH configuration test proves no root/password/metadata-key/forwarding path;
- signed artifact accepts the expected key/digest and rejects tampering,
  downgrade, wrong environment, and unknown signer;
- dead-man and off-host evidence distinguish stale from healthy;
- maintenance operation is idempotent, resumable, and bounded.

### Staging

- clean VM bootstrap with no manual repair;
- Pro attach and Livepatch activation survive reboot and replacement;
- security update with no restart requirement;
- rolling hub-worker restart after a library update;
- dependency-service maintenance and full VM reboot;
- bad kernel recovery through provider console;
- Cloudflare tunnel, browser sign-in, project route/start, terminal, Jupyter,
  Codex, admin, and billing smoke after reboot;
- Postgres full/differential backup, WAL archive, SQLite backup, and disposable
  PITR after service-user split and systemd hardening;
- OS Login/IAP access plus break-glass exercise;
- provider and host firewall canary from public, project-host, bay, and operator
  source classes;
- signed-release tamper test;
- posture/report and logging dead-man test.

### Production Canary

- one human-approved maintenance operation with before/after evidence;
- no unexplained health, latency, auth, project-start, backup, or host-control
  regression;
- external probe remains authoritative when the bay is unavailable;
- every exception has an owner and expiry.

## 16. Acceptance Criteria

1. Installed and running kernel versions match, or a dated maintenance
   operation with a policy-compliant deadline exists.
2. A reboot requirement cannot remain visible only through MOTD.
3. Security package/update failure and posture loss page through an off-host
   path.
4. Ubuntu Pro/Livepatch state is current and externally visible.
5. Every long-running service has its own identity, minimal credential set,
   writable paths, network families, and tested sandbox profile.
6. Compromising a hub worker does not grant direct read/write access to
   Postgres files, Conat files, backup credentials, Cloudflare credentials, or
   release executables.
7. Public SSH is removed or restricted to the approved administrative path,
   with OS Login and strong authentication enforced.
8. Provider and host firewalls independently enforce the listener inventory.
9. The bay VM uses a dedicated least-privilege service account and approved
   boot-integrity controls.
10. Bay artifacts are immutable, signed, SBOM-backed, and verified before
    activation.
11. Security/audit evidence survives bay loss or compromise.
12. A clean staging replacement and reboot complete without manual SSH repair.
13. Production backup/WAL status remains healthy and a disposable PITR drill
    passes on schedule.
14. A quarterly evidence packet can be generated from durable records rather
    than operator memory.

## 17. Explicit Non-Goals

- Automatic reboot of the only production bay before recovery automation is
  proven.
- Automatic Postgres promotion without fencing.
- Treating Ubuntu Pro, Livepatch, auditd, AppArmor, or an SBOM as a complete
  security solution.
- A raw zero-CVE release gate.
- Moving project data traffic through the bay.
- Combining the immediate kernel reboot with broad architecture changes.
- Publishing exact production network, IAM, identity, or secret inventory.

## 18. Primary References

- Project-host companion plan:
  `/home/user/kucalc/agents/project-host-security-maintenance-and-isolation-plan-2026-08-24.md`
- CoCalc scalable architecture: `src/.agents/scalable-architecture.md`
- CoCalc reliability audit:
  `src/.agents/cocalc-ai-reliability-failure-mode-audit-2026-07-15.md`
- Production health checklist:
  `src/.agents/production-cluster-health-checklist.md`
- Bay backup reliability plan:
  `src/.agents/bay-backup-storage-reliability-plan-2026-08-01.md`
- Ubuntu Pro reboot status:
  https://documentation.ubuntu.com/pro-client/en/latest/references/commands/
- Ubuntu Pro and Livepatch:
  https://documentation.ubuntu.com/pro-client/en/latest/tutorials/security-with-pro/
- GCP OS policy assignments:
  https://docs.cloud.google.com/compute/vm-manager/docs/os-policies/working-with-os-policies
- GCP OS policy IAM warning:
  https://docs.cloud.google.com/compute/vm-manager/docs/os-policies/create-os-policy-assignment
- GCP SSH and OS Login:
  https://docs.cloud.google.com/compute/docs/instances/ssh
- GCP SSH access best practices:
  https://docs.cloud.google.com/compute/docs/connect/ssh-best-practices/login-access
- GCP OS Login security keys:
  https://docs.cloud.google.com/compute/docs/oslogin/security-keys
