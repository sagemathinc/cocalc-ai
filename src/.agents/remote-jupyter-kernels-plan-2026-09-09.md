# Remote Jupyter Kernels Through Reflect

Status: proposed, for maintainer review. No implementation or remote installation
has been performed as part of this plan. Command names and API shapes below are
proposals, not existing interfaces.

## Motivation And Initial Customer Scope

A prospective School customer needs students to create ordinary CoCalc notebooks
whose kernels execute on their CoCalc dedicated GPU VMs. Each student has their
own VM and remote Unix account. The VM is not a shared class-wide kernel server.

The initial supported environment is deliberately specific:

- CoCalc dedicated VMs running Ubuntu 24.04, initially x86_64.
- GCP and Nebius are relevant providers; SSH/kernel management should not depend
  on provider-specific APIs.
- Ports 22 and 443 are open. Kernel traffic requires only SSH on port 22.
- The VM address can change on reboot. Resolve the current endpoint on reconnect
  rather than treating an initial IP address as permanent identity.
- The VM may initially have no suitable Python environment, kernel, Node runtime,
  or Reflect executable installed.
- Passwordless SSH must work from the CoCalc project runtime. SSH access from an
  instructor's laptop alone does not satisfy this requirement.

The maintainer has provided a CPU-only Ubuntu VM reachable from the development
workspace as `ssh jupyter`. After the CPU path works, the maintainer can provide a
GPU VM. The second end-to-end test location is a project on `lite2b.cocalc.ai`.
SSH aliases and credentials in the development workspace must not be assumed to
exist in that project.

This is high priority for the Friday customer meeting. A credible plan and
demonstrated progress are useful; the deadline must not force a claim of complete
production robustness. Scope acceptance by demonstrated behavior, not date alone.

## Goals

1. Preserve CoCalc's full notebook experience while moving only kernel execution.
2. Reuse CoCalc's existing Jupyter messaging implementation, not another notebook
   server or frontend.
3. Make remote preparation explicit, repeatable, diagnosable, and user-owned.
4. Support correct interrupt, restart, shutdown, and bounded orphan cleanup.
5. Register an ordinary local kernelspec whose Reflect launcher proxies a remote
   kernel. Standard kernelspec-based clients must work without a CoCalc-specific
   adapter or Python provisioner plugin.
6. Keep local kernels unchanged and covered by regression tests.

## Non-Goals

- File synchronization, mounting, copying datasets, or reconciling notebook and
  remote filesystem paths. Reflect file sync remains a separate optional feature.
- A full remote CoCalc runtime, project host, JupyterLab, or Jupyter HTTP server.
- A shared GPU scheduler, classroom resource allocation, or multi-tenant VM design.
- Arbitrary OS support or automatic GPU driver repair in the initial release.
- Guaranteed output recovery during network partitions or automatic execution
  replay after reconnect.
- Transparent restoration of Python memory after a VM reboot.

## Existing Integration Points

CoCalc already implements kernel discovery, launching, messaging, execution,
notebook state, outputs, and the UI. Relevant source:

- `src/packages/jupyter/kernel/kernelspecs.ts`: kernelspec discovery without a
  dependency on Python's Jupyter manager.
- `src/packages/jupyter/kernel/kernel-data.ts`: kernel enumeration data.
- `src/packages/jupyter/kernel/launch-kernel.ts`: local process launching and
  connection-file creation.
- `src/packages/jupyter/kernel/kernel.ts`: lifecycle, startup, process signals,
  messaging integration, and cleanup.
- `src/packages/jupyter/zmq/index.ts`: CoCalc's ZeroMQ channels and connection info.
- `src/packages/jupyter/redux/project-actions.ts`: notebook/backend coordination.
- `src/packages/frontend/jupyter`: existing notebook UI and kernel selection.

The important integration constraint is that kernel lifecycle code currently
assumes a local child process and process-group signals. Merely replacing a
kernelspec command with `ssh` does not make interrupt or shutdown correct.
Audit local-PID consumers, startup timeouts, process metrics, exit hooks, and
`closeAll` as part of introducing remote lifecycle support.

Reflect source is in `/home/user/upstream/reflect-sync`:

- `src/forward-runner.ts`: SSH forwarding process launch.
- `src/forward-manage.ts`: forwarding management.
- `src/session-daemon.ts`: persistent forwarding reconciliation.
- `src/ssh-control.ts`: SSH control-connection management.
- `src/remote.ts`: remote command discovery and execution.
- `src/index.ts`: current public library exports.
- Standalone executable/release packaging scripts.

These are reusable building blocks, not a completed remote-kernel manager. For
example, the current forward runner regards an SSH process surviving 200 ms as
running; it does not establish destination or Jupyter readiness. Remote helper
bootstrap and standalone compatibility on the minimal VM need explicit validation.

## Architecture And Ownership

```text
Browser
  | existing CoCalc notebook communication
CoCalc project runtime
  | existing Jupyter ZeroMQ client (or another standard local Jupyter client)
Local ports from the client-supplied connection file
  | Reflect-managed TCP forwards through SSH
Remote language kernel + small Reflect lifecycle supervisor
```

An ordinary local kernelspec launches a long-lived Reflect process that manages
these forwards and bridges local process lifecycle to the remote supervisor.
This is a local proxy kernel from the client's perspective, not a second language
interpreter. The same launcher must work outside CoCalc.

CoCalc owns notebook state, collaboration, frontend behavior, project
authorization, kernel selection, and Jupyter protocol handling. Reflect owns SSH,
remote helper preparation, kernel environment discovery/preparation, process
lifecycle, grouped forwards, and session diagnostics. The language kernel executes
notebook code remotely. Reflect must not acquire a dependency on CoCalc.

Forward the Jupyter wire protocol over TCP without decoding and re-encoding every
message in a new local protocol proxy. This preserves the existing message
signatures, routing, and binary payloads. Reflect's lifecycle management is
separate from the notebook execution protocol.

Steady-state traffic goes from the project runtime to the VM, not through the hub.
Any dedicated-VM discovery or ownership checks use the existing authoritative
control-plane routes; do not assume a local bay database owns the VM/project.
Manual SSH target configuration should work without provider integration.

### Three Distinct Objects

- **Target:** stable target identity, SSH destination, verified host identity,
  remote account, and a credential reference.
- **Environment:** a remote interpreter/kernelspec with a stable environment ID,
  display name, language, and preparation/validation state.
- **Session:** one running kernel with its own UUID, incarnation, process group,
  connection key, remote ports, local forward group, and lifecycle state.

Two notebooks selecting the same environment normally launch separate kernels.
Collaborators viewing the same notebook should share its existing project-owned
session, not create a kernel per browser tab.

### Standard Kernelspec Contract

The foundational interface is a conventional kernelspec, for example:

```json
{
  "argv": [
    "reflect",
    "jupyter",
    "launch",
    "--target",
    "my-gpu",
    "--environment",
    "teaching",
    "--connection-file",
    "{connection_file}"
  ],
  "display_name": "Python - My GPU VM",
  "language": "python",
  "interrupt_mode": "signal"
}
```

Registration should resolve the local Reflect executable to an absolute path.
The launcher consumes the connection file supplied by the Jupyter client/manager:
it must use that file's local ports, IP, key, and signature scheme, not replace
them with a different descriptor that only a custom CoCalc adapter understands.
Initial support is loopback TCP; reject unsupported transports or unsafe bind
addresses with clear errors rather than silently changing them.

Remote ports may differ from local ports. Create a separate private remote
connection file and map the client's local endpoints to the actual remote
endpoints. Preserve the signing configuration end to end. The caller owns its
connection file; Reflect cleans up its own remote files and session artifacts.

The local launcher remains alive for the managed session, reports bounded/redacted
diagnostics on stderr, and exits when the session terminates or is irrecoverably
lost. The ordinary client must observe remote failure through process exit, not
be left with an apparently healthy launcher. Its exit must not cause a Reflect
daemon to resurrect a terminated kernel behind the client's back.

Signal handling must match the declared interrupt mode. For the initial
signal-based contract, translate local SIGINT to a remote interrupt and local
SIGTERM to remote termination. CoCalc signals process groups: isolate SSH children
from the group receiving client interrupts so SIGINT does not kill the tunnel
before the launcher can forward it. Local SIGKILL cannot be handled; remote lease
expiry is the cleanup backstop even if other local Reflect processes survive.

Standard Jupyter shutdown requests travel through the tunnel to the remote
kernel. Observe its exit and close the launcher. Test protocol-driven shutdown
and client-manager restart behavior as well as OS signals. Remote kernels using
message-based interruption need an explicit supported translation, not an
unverified change to the local kernelspec's interrupt mode.

### CoCalc Integration

First use CoCalc's existing kernelspec discovery, local process launcher, and
ZeroMQ transport unchanged. CoCalc-specific work should primarily supply target
setup, environment preparation, registration, and richer diagnostics. Introduce
only the small lifecycle adjustments demonstrated necessary by compatibility
tests; a parallel remote-kernel backend is not the starting architecture.

Do not model the remote kernel PID as the PID of the local SSH process. Remote
metrics must be labeled as such, or explicitly unavailable, rather than reporting
the SSH client's CPU and memory as kernel resource use.

Expose remote environments through the existing kernel selector with stable names
such as `Python - My GPU VM`. Persist an opaque target/environment reference, not
SSH secrets or transient ports, in notebook-facing configuration. A notebook
opened in a project without that target should offer an explicit replacement,
not silently execute on a different machine.

Compatibility with JupyterLab, `jupyter console`, and relevant nbconvert/nbgrader
execution paths is an acceptance requirement, not an optional wrapper added
later. All clients use the same kernelspec launcher and session implementation.
Do not claim compatibility with every client until its required behavior is
tested; UI/transport reuse alone is not proof that these paths work.

## Proposed Reflect Surface

Illustrative commands:

```text
reflect jupyter prepare --host jupyter --environment teaching
reflect jupyter kernels --host jupyter
reflect jupyter register --target my-gpu --environment teaching
reflect jupyter launch --target my-gpu --environment teaching --connection-file <path>
reflect jupyter status <session-id>
reflect jupyter interrupt <session-id>
reflect jupyter stop <session-id>
```

`register` installs a local kernelspec; `launch` is the foreground process invoked
by that spec. A future standalone `start` convenience command may create a local
connection file for clients attaching to an existing session, but must reuse the
same lifecycle implementation rather than replace the client-supplied-file path.

Provide structured setup/status operations usable by CoCalc. Decide between a
dedicated library export and a versioned JSON subprocess protocol for these
management operations during the first integration spike. Kernel launching itself
uses the standard kernelspec contract. Do not scrape human-readable output.
A narrow export should avoid initializing file-sync machinery just to manage a
kernel. Check Node/ESM/runtime compatibility before selecting the embedding mode.

Both CLI and CoCalc must use one authoritative session manager per ownership
scope. Avoid competing CoCalc and Reflect restart loops. Isolate state, sockets,
and runtime directories by project when running on a shared project host.

## Preparation

Preparation is a separate, explicit operation, not an unbounded package install
hidden behind every notebook launch.

1. Verify noninteractive SSH and host identity; report actionable authentication,
   routing, or forwarding-policy failures.
2. Probe OS/architecture, writable runtime location, available interpreters, and
   existing Reflect/kernel versions.
3. Install a pinned, integrity-verified compatible Reflect helper in a user-owned,
   versioned location when absent. Use atomic installation, an installation lock,
   and absolute paths. Do not depend on interactive shell PATH initialization.
4. Prefer an explicitly selected existing Python/GPU environment. Otherwise
   prepare an isolated Python environment with pinned/tested kernel dependencies,
   bootstrapping Python if necessary. Do not alter system Python.
5. Verify imports and a real Jupyter handshake before marking an environment ready.

Choose the Python bootstrap mechanism after probing the minimal Ubuntu VM. A
standalone helper should not require installing a full Node development toolchain.
No silent `sudo`, global upgrades, or unverified remote install scripts.

GPU preparation is separate from installing `ipykernel`: identify the provider
image/driver state, select a supported framework recipe, and verify an actual GPU
operation from the kernel. A visible GPU device alone is not sufficient evidence.

## Launch And Readiness

1. Read and validate the client-supplied connection file. Allocate a session ID
   and launch attempt/incarnation; make retries within that launch idempotent.
2. Start the remote supervisor and kernel in a private runtime directory.
3. Obtain the kernel's actual bound connection information. Handle port allocation
   races with bounded retries, not a permanent assumption that probed ports stay free.
4. Create a forward group for all five standard Jupyter ports, including heartbeat,
   preferably over one SSH connection. Bind the exact client-supplied local ports
   to loopback and forward to the actual remote kernel ports. A local bind failure
   is a startup failure, not permission to choose new client ports silently.
5. Keep the remote kernel on loopback and use the client's signing configuration.
   No replacement client descriptor or CoCalc-specific connection negotiation is
   required. Leave the client-owned connection file unchanged.
6. Require SSH forwarding success and a bounded Jupyter readiness handshake from
   the ordinary client. Reflect may expose transport readiness separately; it must
   not mistake a live SSH process for a responsive kernel or consume client replies.
7. Publish ready state only after the entire operation succeeds; otherwise unwind
   partial processes, forwards, and private connection files.

Persist enough session identity to distinguish a live kernel from a reused PID or
port. A remote boot identity and per-launch nonce/incarnation should participate
in reconnect validation. Reconnect must not trust a PID alone.

Connection descriptors contain execution credentials. Keep them out of ordinary
CLI output, application logs, notebook metadata, and synchronized documents.

## Lifecycle And Failure Semantics

Suggested observable states: preparing, connecting, starting, ready, disconnected,
stopping, stopped, lost, and failed. Keep Jupyter busy/idle state separate from
transport/process state. Report which stage failed.

- **Interrupt:** the local launcher translates client signals to the remote kernel
  process group through the supervisor;
  respect message-based interrupt modes where applicable. Do not signal SSH as a
  substitute. Escalate separately if interrupt cannot stop a busy kernel.
- **Restart:** stop and confirm termination of the old incarnation, then create a
  new one. Do not start duplicates while termination status is unknown.
- **Browser refresh/disconnect:** preserve the project-owned kernel.
- **Brief SSH loss:** reconnect with bounded backoff to the same verified remote
  incarnation while its lease remains valid. Mark in-flight execution uncertain;
  do not automatically resubmit it.
- **VM reboot:** mark the old session lost. Resolve the current endpoint and offer
  an explicit new kernel; do not imply that memory state survived.
- **Project shutdown/abandonment:** request orderly shutdown, escalate after a
  timeout, and use remote lease expiry as the cleanup backstop.
- **Remove target:** stop owned sessions explicitly before removing configuration.

A local owner renews the remote supervisor's bounded lease only while the owning
launcher/session is alive; daemon liveness alone must not renew it. The supervisor must
survive transient SSH loss, but terminate the owned process group after lease
expiry. Choose and document the grace period; it trades off temporary disconnect
tolerance against abandoned GPU cost. Distinguish remote process cleanup from VM
shutdown: stopping a kernel does not stop dedicated-VM billing.

Do not claim lossless recovery of output produced while SSH was disconnected.
Output buffering/replay would require a separately designed protocol and is not
part of this first implementation.

## Security And Access Boundaries

- Preserve SSH host-key verification; explicitly handle host replacement rather
  than disabling checking to accommodate address changes.
- Use noninteractive SSH, bounded waits, keepalives, and forward-failure detection.
- Avoid agent forwarding and placing private keys into notebooks or remote helpers.
- Treat remote execution as the configured remote Unix account's authority.
- Project collaborators generally share the project's execution authority. Do not
  suggest that a credential available to that runtime is private from its code.
- One VM/account per student is the initial isolation model. A shared remote Unix
  account must not be represented as isolated simply because kernels differ.
- Persist only the secrets necessary for managed sessions, with restrictive file
  permissions and redacted diagnostics. Use structured arguments and proper remote
  shell escaping; reject invalid target/session identifiers.

## Implementation Phases

All phases below are pending approval and implementation.

### 1. CPU Transport And Lifecycle Spike

Use `ssh jupyter` to probe the minimal VM, prepare one Python environment, launch a
kernel through a registered local kernelspec, and connect using both a conventional
Jupyter client and CoCalc's existing launcher/ZeroMQ implementation. Exercise the
client-supplied connection file, supervisor, grouped forwards, signal translation,
and cleanup before investing in a wizard or a custom CoCalc lifecycle adapter.

Deliverable: a repeatable standalone demonstration and an agreed lifecycle/API
contract. Use synthetic workloads and no production student data.

### 2. Reflect Session Implementation

Implement the session records, helper bootstrap, environment operations, lifecycle
commands, standard kernelspec registration/launch, leases, and reconnect behavior.
Add focused tests and disposable-SSH
integration tests, including partial startup failures and duplicate launch retries.

Deliverable: independently usable Reflect commands with structured output and
documented failure semantics. File sync is not required to run these tests.

### 3. CoCalc Integration

Add target/environment setup and registration controls, existing kernel-selector
integration, and diagnostic states around the standard launcher. Make minimal
lifecycle adjustments only where the spike demonstrates they are necessary.
Validate startup and cleanup through the real project runtime. Follow the frontend
accessibility/theme guidance for any new controls.

Deliverable: a student account can create a notebook, select the remote environment,
and use the full supported notebook workflow from a project on `lite2b`.

### 4. GPU And Customer Workflow

Repeat on a supplied GPU VM, validate the selected framework, and exercise the
instructor/student setup flow. Test GCP and Nebius separately before claiming both
recipes are validated. Document provisioning steps, supported images, and known
limits for the customer meeting.

### 5. Release Gate

Review credential handling and lifecycle failure tests, run relevant package
typechecks/tests and frontend lint, and confirm local-kernel regressions are absent.
Do not mark phases complete merely because a single cell executed remotely.

## Acceptance Matrix

- Clean minimal Ubuntu bootstrap; repeated preparation; interrupted installation;
  existing compatible environment; unsupported/missing prerequisites.
- Actual student/project SSH access, not just development-machine connectivity.
- The same registered kernelspec launches through CoCalc, JupyterLab, and
  `jupyter console` without a custom client plugin or CoCalc service dependency.
- Client-supplied local ports/signing key are honored; remote ports may differ;
  heartbeat works; the client connection file is neither replaced nor deleted.
- Local process and process-group interrupt/termination, protocol shutdown,
  manager-driven restart, launcher SIGKILL, and remote crash all have correct
  remote cleanup and local process-exit behavior.
- Execute, stream output, display errors and rich output, completion, inspection,
  stdin, widget communication, and binary Jupyter payloads.
- Two simultaneous notebooks with independent variables, output, ports, and keys.
- Two browser views of one notebook reuse its one session.
- Interrupt a busy kernel, restart it, shut it down, and verify remote cleanup.
- Browser refresh, project process loss, SSH interruption, VM reboot, changed
  endpoint, and lease expiry with bounded cleanup.
- Failed forwarding, occupied ports, failed kernel startup, failed readiness,
  stale incarnation, and a retry after an uncertain launch response.
- Late async results from an old session do not mutate or terminate a replacement.
- Local kernels, CLI notebook execution, and relevant nbgrader/nbconvert paths.
- GPU computation and restart on each provider/image claimed as supported.

Record results separately as automated, live CPU VM, live GPU VM, and actual
student-account evidence. No single category substitutes for the others.

## Decisions For Review

1. Confirm Reflect as the reusable lifecycle/bootstrap implementation and CoCalc as
   the notebook/protocol owner.
2. Treat ordinary kernelspec registration/launch as the required client contract.
   Choose library export versus structured subprocess only for additional
   management operations after checking runtime compatibility.
3. Choose the Ubuntu Python bootstrap and first supported GPU framework recipe.
4. Choose lease grace period and initial reconnect policy. Explicit loss/restart
   is preferable to unverified transparent recovery.
5. Decide the minimum registration UI for the first milestone. A manual target
   setup may precede dedicated-VM discovery, but student access must be tested.

## Alternatives Considered

- Python Jupyter provisioners: useful lifecycle concepts, but not automatically
  invoked by CoCalc's TypeScript launcher. See
  <https://jupyter-client.readthedocs.io/en/stable/provisioning.html>.
- Existing SSH launchers such as <https://github.com/casangi/sshpyk> and
  <https://github.com/tdaff/remote_ikernel>: useful references or spike candidates;
  adopting one still requires proving lifecycle compatibility with CoCalc.
- Gateway server or full CoCalc runtime on the VM: unnecessary extra machinery
  for this scope and contrary to the desired lightweight design.

The recommendation is a standard local kernelspec backed by a Reflect remote
kernel launcher, with CoCalc setup/diagnostics integration and only necessary
lifecycle adjustments. Prove the same launcher in CoCalc and a conventional
Jupyter client on the CPU VM, then validate GPU environments.
