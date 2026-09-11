# Remote Jupyter Kernels

Run a CoCalc notebook's Jupyter kernel on a dedicated VM while retaining CoCalc's
notebook editor, collaboration, outputs, and grading support. The same installed
kernelspec also works in standard local Jupyter clients. No CoCalc runtime,
Jupyter HTTP server, or Node installation is required on the VM.

## Initial Supported Environment

- Ubuntu 24.04 x86_64 dedicated VM, with one VM/Unix account per student.
- Noninteractive SSH from the student's **CoCalc project**, with a verified host
  key. Laptop SSH access alone is insufficient.
- Outbound HTTPS for explicit Python/package preparation; kernel traffic uses
  SSH port 22 only. No Jupyter ports need to be exposed publicly.
- For the GPU recipe, working NVIDIA drivers and sufficient disk space for
  several GB of PyTorch/CUDA packages. The validated device is an NVIDIA L40S
  with driver 580.173.02; other provider images need separate validation.
- An updated CoCalc project tools bundle containing `reflect` 0.17.0 or newer.

The SSH transport is provider-independent. This does not imply that every GCP
or Nebius GPU image/framework combination has been tested.

## Instructor And Student Setup

1. Provision each student's VM and give that student access to its Unix account.
   Do not use a shared remote account as a substitute for student isolation.
2. In the student's CoCalc project, create a dedicated SSH key and authorize its
   public key on that VM using the normal VM access workflow. Verify the VM host
   key through a trusted source. Keep private keys out of notebooks and chat.
3. Configure an SSH alias in the project's `~/.ssh/config`, for example:

   ```sshconfig
   Host my-gpu
       HostName vm-example.cocalc.ai
       User user
       IdentityFile ~/.ssh/my-gpu
       IdentitiesOnly yes
   ```

4. Verify access from a project terminal:

   ```sh
   ssh -o BatchMode=yes -o StrictHostKeyChecking=yes my-gpu true
   ```

5. Open a notebook's kernel selector and choose **Remote kernel**. Select an SSH
   alias, or type a destination and press **Connect**. SSH must succeed before
   any kernel configuration is offered. Alias discovery reads the project's
   SSH config and Includes; OpenSSH still handles the actual connection.
6. Choose a discovered kernel (any language), or create Python / GPU Python
   (PyTorch). A supported NVIDIA GPU makes PyTorch the default suggestion; an
   inconclusive probe displays a warning, not a CPU-only result. Kernel and
   environment names are filled automatically. Click **Set up kernel**.

**Advanced** exposes the names, existing Python interpreter option, software
recipe, and an additional remote kernelspec directory for environments outside
the normal search paths. Discovery covers Jupyter's reported catalog, standard
data directories, and Reflect-managed environments. It cannot find arbitrary
unregistered installations anywhere on disk; add their kernelspec directory.
Discovery is read-only and never installs software or starts a kernel.

Existing kernels retain their language, argv, environment, and interruption
mode. Setup validates their executable and connection-file arguments; the client
performs the Jupyter readiness handshake when launching. Python preparation and
the explicit Python-interpreter path additionally perform a setup-time handshake.
The registered kernel is selected in the notebook. Python 3 is needed for remote
discovery/supervision, not as the language of the chosen kernel. On minimal VMs
without Python, explicit preparation can bootstrap the private runtime first.

Collaborators able to run code in a project share its execution authority,
including SSH credentials accessible to that project. Use separate projects and
VM accounts where that sharing is not appropriate. No site-admin role is required
for setup from an otherwise authorized project.

## Terminal Equivalent

```sh
reflect jupyter ssh-targets
reflect jupyter discover --host my-gpu
# Include a separately installed Bash, SageJS, or other language environment:
reflect jupyter discover --host my-gpu --search-path /opt/env/share/jupyter/kernels
reflect jupyter target add my-bash --host my-gpu \
  --kernel /opt/env/share/jupyter/kernels/bash/kernel.json

# CPU environment:
reflect jupyter target add my-vm --host my-gpu --environment teaching

# Explicit GPU environment preparation; requires working NVIDIA drivers:
reflect jupyter target add my-vm --host my-gpu \
  --environment pytorch --recipe pytorch-cu128

# Or retain an existing environment without modifying it:
reflect jupyter target add my-vm --host my-gpu \
  --environment existing --python /home/user/venv/bin/python

jupyter console --kernel reflect-my-vm
```

Use one setup alternative per target. Existing local kernel names are never
overwritten. Compatible marked environments can be reused; unknown or mismatched
environment names require a different name. The
Python recipe pins `ipykernel` 6.30.1 and `ipywidgets` 8.1.7. The GPU recipe adds
PyTorch 2.8.0/CUDA 12.8 and NumPy 2.2.6, and checks actual CUDA matrix computation.
Preparation uses pinned, checksum-verified uv; it does not invoke sudo or modify
system Python. Environments are published only after validation. Repeated setup
checks an existing environment; changing recipes requires a new environment name.

Validate GPU execution from the selected notebook:

```python
import socket, torch
print(socket.gethostname(), torch.__version__)
assert torch.cuda.is_available()
x = torch.ones((1024, 1024), device="cuda")
assert (x @ x)[0, 0].item() == 1024
torch.cuda.synchronize()
print(torch.cuda.get_device_name())
```

## Lifecycle And Diagnostics

Each notebook launch has its own kernel. Multiple collaborators opening the same
notebook continue using its project-owned session. Interrupt and normal restart
operate on the remote process group; CoCalc waits for shutdown before admitting a
replacement. Remote CPU/RAM readings are unavailable, not the local SSH process's
usage.

The supervisor has a 60-second default renewable lease. A separate guardian
terminates the kernel group if its supervisor dies. Abrupt local process death
falls back to lease expiry. A conventional client that forces SIGKILL may start
a replacement before that lease expires; graceful restarts avoid this overlap.

SSH reconnection reuses the same verified session and never replays execution.
Output generated during disconnection may be lost and in-flight work uncertain.
A VM reboot loses kernel memory and requires an explicit restart. Use a stable
VM DNS name so new SSH connections resolve its current address. A changed host
key requires explicit verification, not disabling host-key checking.

```sh
reflect jupyter target list
reflect jupyter list
reflect jupyter status SESSION_ID
reflect jupyter interrupt SESSION_ID
reflect jupyter stop SESSION_ID
reflect jupyter remove SESSION_ID
reflect jupyter target remove my-vm --stop
```

Use a local integer ID from `reflect jupyter list`, or the session UUID exposed
by `reflect jupyter list --json`. Connection credentials are not part
of ordinary status output. Removal is also available in **Remote kernel >
Registered kernels**. It disables new launches, stops recorded sessions, then
removes the local kernelspec/configuration. Failed removal remains disabled and
can be retried when SSH connectivity returns.

For a permanently unavailable remote, `reflect jupyter remove SESSION_ID --force`
forgets only its local session record without contacting the remote or confirming
kernel shutdown. It leaves target registrations intact. Normal session removal
requires confirmed shutdown; `--stop` explicitly stops first. Do not combine
`--stop` with `--force`. A local launcher must exit before its record is removed.

**Removing a target or stopping a kernel does not stop the VM or its billing.**
It also does not delete the remote environment.

## Files And Release Scope

Kernel code sees the remote VM's filesystem. This feature does not synchronize
files, translate paths, or copy datasets. Reflect file synchronization is a
separate option, not a prerequisite for the kernel transport.

The implementation is split between Reflect's reusable standard-kernelspec
launcher and CoCalc's setup/lifecycle integration. Full and minimal tools builds
include the same platform-independent JS bundle, pinned by commit and source
archive SHA256 in `src/packages/project/sea/reflect-source.json`. Existing projects
need an updated tools bundle (or an explicitly installed Reflect) before using
the setup control.
