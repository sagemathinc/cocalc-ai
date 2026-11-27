#!/usr/bin/python3
# Trusted lifecycle supervisor. Never execute project code with host privileges.
import base64
from contextlib import contextmanager
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import select
import selectors
import signal
import sys
import time
import uuid

POOL = Path("__PROJECT_POOL_CGROUP__")
RUNTIME_USER = "__RUNTIME_USER__"
LOCK = Path("/run/lock/cocalc-project-cgroups.lock")
STATE = Path("/run/cocalc-managed-project-jobs")
PODMAN = "/opt/cocalc/container-runtime/current/bin/podman"
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
JOB = re.compile(r"job-(\d+)-(\d+)-(\d+)-(\d+)-(\d+)-(" + UUID + r")$")
# The OOM policy of every project process (as the project launcher applies).
PROJECT_OOM_SCORE_ADJ = "500"
LEGACY_JOB = re.compile(r"job-\d+-\d+-\d+-\d+-" + UUID + r"$")

class LifecycleBusy(RuntimeError):
    pass

class AdmissionBlocked(RuntimeError):
    pass

class AdmissionCancelled(RuntimeError):
    pass

def stdin_closed():
    # The runtime cancels by ending stdin, then SIGKILLs sudo 45s later, while
    # admission may wait much longer for the lifecycle lock. Detect the hangup
    # without reading: the job configuration may still be queued unread.
    hangup = select.POLLHUP | select.POLLERR | getattr(select, "POLLRDHUP", 0)
    poller = select.poll()
    poller.register(0, select.POLLIN | getattr(select, "POLLRDHUP", 0))
    return any(events & hangup for _, events in poller.poll(0))

@contextmanager
def lifecycle_lock(wait=15, cancelled=None):
    fd = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        if os.fstat(fd).st_uid != 0:
            raise RuntimeError("untrusted lifecycle lock")
        until = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if cancelled is not None and cancelled():
                    raise AdmissionCancelled("cancelled while waiting for the lifecycle lock")
                if time.monotonic() >= until:
                    raise LifecycleBusy("project lifecycle busy")
                time.sleep(0.05)
        yield fd
    finally:
        os.close(fd)

def require_inherited_lock():
    # These operations are internal calls from the root storage wrapper, which
    # already holds fd 9. Never acquire a second open-file-description lock.
    actual, expected = os.fstat(9), LOCK.stat()
    if (actual.st_dev, actual.st_ino, actual.st_uid) != (expected.st_dev, expected.st_ino, 0):
        raise RuntimeError("missing lifecycle lock")
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)

def state_path(project):
    if not re.fullmatch(UUID, project):
        raise ValueError("invalid project")
    STATE.mkdir(mode=0o700, exist_ok=True)
    if STATE.is_symlink() or STATE.stat().st_uid != 0 or STATE.stat().st_mode & 0o077:
        raise RuntimeError("untrusted admission state")
    return STATE / project

def read_state(project):
    path = state_path(project)
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None

def write_state(project, value):
    path = state_path(project)
    temporary = path.with_name(project + ".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)

def parent_scope(project):
    parent = POOL / ("project-" + project)
    if not parent.is_dir() or parent.is_symlink() or parent.stat().st_uid != 0:
        raise RuntimeError("project containment unavailable")
    return parent

def member(pid, scope):
    expected = "/" + str(scope.relative_to(Path("/sys/fs/cgroup")))
    return "0::" + expected in Path(f"/proc/{pid}/cgroup").read_text().splitlines()

def active_state(project):
    value = read_state(project)
    parent = parent_scope(project)
    if (not value or value["status"] != "active" or
        value["inode"] != parent.stat().st_ino or
        not alive(value["init"], value["start"]) or not member(value["init"], parent)):
        raise AdmissionBlocked("project job admission is blocked")
    return value

def activate(project, init):
    with lifecycle_lock():
        previous = read_state(project)
        if previous and previous["status"] == "stopping":
            raise RuntimeError("project cleanup is unresolved")
        parent = parent_scope(project)
        start = identity(init)
        if not member(init, parent):
            raise RuntimeError("project generation is not contained")
        reap_project_locked(project)
        # Repeated finalization is idempotent; it cannot replace a live generation.
        if previous and previous["status"] == "active":
            if active_state(project)["init"] != init or previous["start"] != start:
                raise RuntimeError("project generation changed without cleanup")
            return
        if any(path.is_dir() for path in parent.iterdir()):
            raise RuntimeError("unresolved project job scopes")
        write_state(project, {"status": "active", "generation": str(uuid.uuid4()),
                             "inode": parent.stat().st_ino, "init": init, "start": start})

def begin_stop_locked(project):
    # Persist before either startup or main cgroup is killed. Failed teardown,
    # helper/worker crashes and retries must never reopen admission.
    write_state(project, {"status": "stopping"})
    parent = POOL / ("project-" + project)
    if parent.exists():
        parent_scope(project)
        (parent / "cgroup.kill").write_text("1\n")

def cleanup_locked(project):
    begin_stop_locked(project)
    parent = POOL / ("project-" + project)
    if parent.exists():
        parent_scope(project)
        failed = False
        until = time.monotonic() + 10
        for scope in parent.iterdir():
            if not scope.is_dir():
                continue
            try:
                validate_scope(scope)
                kill_scope(scope, max(0, until - time.monotonic()))
            except Exception:
                failed = True
        if failed:
            raise RuntimeError("project job cleanup not confirmed")
        kill_scope(parent, max(0, until - time.monotonic()))
    write_state(project, {"status": "stopped"})
    quarantine_path(project).unlink(missing_ok=True)

def validate_scope(scope):
    if (scope.is_symlink() or scope.stat().st_uid != 0 or
        not (JOB.fullmatch(scope.name) or LEGACY_JOB.fullmatch(scope.name))):
        raise RuntimeError("unrecognized job scope")

def identity(pid):
    text = Path(f"/proc/{pid}/stat").read_text()
    fields = text[text.rindex(")") + 2:].split()
    if fields[0] in ("Z", "X"):
        raise ProcessLookupError("process is dead")
    return fields[19]

def alive(pid, start):
    try:
        return identity(int(pid)) == start
    except (FileNotFoundError, ProcessLookupError):
        return False

class BackgroundWarningTracker:
    # The in-project supervisor may already have warned before killing its
    # process group. Only deduplicate diagnostics; never affect cgroup cleanup.
    note = (b"Background processes were terminated when the command exited; "
            b"use cocalc project terminal spawn for persistent services.\n")

    def __init__(self):
        self.seen = False
        self.tail = b""

    def observe(self, stream, chunk):
        if stream != "stderr" or self.seen:
            return
        text = self.tail + chunk
        self.seen = self.note in text
        self.tail = b"" if self.seen else text[-(len(self.note) - 1):]

# Podman's own processes for the exec session (e.g. conmon) can outlive the
# command for a moment. They are not the command's leftovers.
JOB_INFRASTRUCTURE = frozenset({"conmon", "podman", "catatonit", "crun", "runc"})

def process_name(pid):
    return Path(f"/proc/{pid}/comm").read_text().strip()

def live_scope_processes(scope, grace=0.5):
    # Diagnostic only. Cleanup always uses atomic cgroup.kill, never this count.
    # Allow exiting processes a moment to go, so that the "remaining job
    # processes" note is printed only for processes the command left behind.
    until = time.monotonic() + grace
    while True:
        try:
            pids = (scope / "cgroup.procs").read_text().split()
        except OSError:
            return 0
        count = 0
        for pid in pids:
            try:
                identity(int(pid))
                name = process_name(int(pid))
            except (OSError, ValueError):
                continue
            if name not in JOB_INFRASTRUCTURE:
                count += 1
        if count == 0 or time.monotonic() >= until:
            return count
        time.sleep(0.05)

def kill_scope(scope, timeout=10):
    # cgroup.kill covers fork/setsid/reparenting races, unlike PID enumeration.
    try:
        (scope / "cgroup.kill").write_text("1\n")
    except FileNotFoundError:
        if not scope.exists():
            return
        raise
    until = time.monotonic() + timeout
    while True:
        try:
            if "populated 0" in (scope / "cgroup.events").read_text().splitlines():
                scope.rmdir()
                return
        except FileNotFoundError:
            if not scope.exists():
                return
            raise
        except OSError as error:
            if error.errno != errno.EBUSY:
                raise
        if time.monotonic() >= until:
            raise RuntimeError("job containment cleanup not confirmed")
        time.sleep(0.05)

def quarantine_path(project):
    return state_path(project).with_suffix(".quarantine")

def reap_project_locked(project):
    # Only this project's cleanup gates its admission. No waits for dying
    # processes under the host-wide lock: subsequent sweeps retry busy scopes.
    quarantine = quarantine_path(project)
    try:
        sweep_project_locked(project)
    except Exception:
        temporary = quarantine.with_suffix(".quarantine.tmp")
        temporary.write_text(json.dumps({"cleanup_error": "job cleanup not confirmed",
                                         "observed_at": time.time()}))
        temporary.replace(quarantine)
        raise
    quarantine.unlink(missing_ok=True)

def sweep_project_locked(project):
    parent = POOL / ("project-" + project)
    if not parent.exists():
        return
    parent_scope(project)
    failed = False
    try:
        active_state(project)
        stopping = False
    except Exception:
        stopping = True
    for scope in parent.iterdir():
        if not scope.is_dir():
            continue
        try:
            validate_scope(scope)
            match = JOB.fullmatch(scope.name)
            expired = True  # Legacy scopes have no enforceable deadline.
            if match:
                owner, owner_start, guard, guard_start, deadline, _ = match.groups()
                expired = (stopping or time.monotonic() * 1000 >= int(deadline) or
                           not alive(owner, owner_start) or not alive(guard, guard_start))
            if expired:
                kill_scope(scope, timeout=0)
        except Exception:
            failed = True
    if failed:
        raise RuntimeError("abandoned job cleanup not confirmed")

def reap():
    failed = 0
    for parent in POOL.glob("project-*"):
        if not re.fullmatch("project-" + UUID, parent.name):
            continue
        try:
            with lifecycle_lock():
                reap_project_locked(parent.name.removeprefix("project-"))
        except Exception:
            failed += 1
    # This aggregate is diagnostic only (periodic caller logs a warning), never
    # an admission decision. Every other project has already been attempted.
    if failed:
        raise RuntimeError("some project job sweeps failed")

def confirm_cleanup():
    # Read-only, bounded recovery for identities emitted by this supervisor.
    # A successful global sweep is NOT evidence that a particular job is gone.
    jobs = config_from_stdin().get("jobs")
    if not isinstance(jobs, list) or len(jobs) > 64:
        raise ValueError("invalid cleanup queries")
    for job in jobs:
        if (not isinstance(job, dict) or
            not isinstance(job.get("project_id"), str) or
            not re.fullmatch(UUID, job["project_id"]) or
            not isinstance(job.get("scope"), str) or
            len(job["scope"]) > 256 or not JOB.fullmatch(job["scope"])):
            raise ValueError("invalid cleanup identity")
    confirmed = []
    with lifecycle_lock():
        # Refuse missing/untrusted mounts rather than treating them as cleanup.
        if POOL.is_symlink() or POOL.stat().st_uid != 0:
            raise RuntimeError("untrusted containment pool")
        for job in jobs:
            try:
                parent = POOL / ("project-" + job["project_id"])
                if parent.is_symlink():
                    continue
                if parent.exists():
                    parent_scope(job["project_id"])
                scope = parent / job["scope"]
                # lstat distinguishes absence from symlinks and read errors.
                try:
                    scope.lstat()
                except FileNotFoundError:
                    confirmed.append({"project_id": job["project_id"], "scope": job["scope"]})
            except OSError:
                continue
            except RuntimeError:
                continue
    print(json.dumps({"confirmed": confirmed}), flush=True)

def config_from_stdin():
    # Bound startup waiting and input before creating any execution authority.
    sel = selectors.DefaultSelector()
    sel.register(0, selectors.EVENT_READ)
    data = bytearray()
    until = time.monotonic() + 5
    try:
        while b"\n" not in data:
            if time.monotonic() >= until:
                raise RuntimeError("missing job configuration")
            if not sel.select(0.1):
                continue
            chunk = os.read(0, 4096)
            if not chunk:
                raise RuntimeError("job owner disconnected")
            data.extend(chunk)
            if len(data) > 128 * 1024:
                raise ValueError("job configuration too large")
        return json.loads(data.split(b"\n", 1)[0])
    finally:
        sel.close()

def apply_project_oom_policy(pid, proc=Path("/proc")):
    # A job inherits this supervisor's host-service OOM protection. Without
    # resetting it, at the project's memory limit the kernel spares a huge job
    # (e.g. parallel test workers) and kills the project's agent instead.
    path = proc / str(pid) / "oom_score_adj"
    path.write_text(PROJECT_OOM_SCORE_ADJ + "\n")
    if path.read_text().strip() != PROJECT_OOM_SCORE_ADJ:
        raise RuntimeError("project OOM policy not applied")

def launch_locked(scope, account, args, env, pipes):
    # Child cannot exec (or fork) until its parent has placed it in the scope
    # and verified membership under the same lock used by project stop.
    gate_read, gate_write = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            os.dup2(pipes[0][0], 0)  # Replace the host control lease immediately.
            os.dup2(pipes[1][1], 1)
            os.dup2(pipes[2][1], 2)
            os.dup2(gate_read, 3)
            os.closerange(4, 65536)  # Includes the inherited lifecycle lock.
            if os.read(3, 1) != b"1":
                os._exit(125)
            os.close(3)
            os.setsid()
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.prctl(8, 0, 0, 0, 0) != 0:  # PR_SET_KEEPCAPS
                os._exit(125)
            os.initgroups(account.pw_name, account.pw_gid)
            os.setresgid(account.pw_gid, account.pw_gid, account.pw_gid)
            os.setresuid(account.pw_uid, account.pw_uid, account.pw_uid)
            caps = Path("/proc/self/status").read_text().splitlines()
            if any(int(line.split()[1], 16) for line in caps
                   if line.startswith(("CapEff:", "CapPrm:", "CapAmb:"))):
                os._exit(125)
            # Do not set PR_SET_NO_NEW_PRIVS: it is inherited through podman
            # exec, so sudo and other setuid tools would fail in agent commands
            # although they work in the same project's terminals. The command
            # runs as the host runtime user, which already execs into project
            # containers without that flag.
            os.chdir("/")
            # Supplied environment/argv are only used after dropping privileges.
            executable = PODMAN if Path(PODMAN).is_file() else "/usr/bin/podman"
            args = ["exec", "-e", "COCALC_MANAGED_JOB_SCOPE=" + scope.name, *args[1:]]
            os.execve(executable, [executable, *args], env)
        except BaseException:
            os._exit(125)
    os.close(gate_read)
    try:
        (scope / "cgroup.procs").write_text(str(child))
        if not member(child, scope):
            raise RuntimeError("launcher containment not confirmed")
        # Before the child can exec: it and everything it starts get it.
        apply_project_oom_policy(child)
        os.write(gate_write, b"1")
        return child
    except BaseException:
        # The child might still be outside the scope if migration failed.
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(child, 0)
        raise
    finally:
        os.close(gate_write)

def lease_connected():
    probe = selectors.DefaultSelector()
    probe.register(0, selectors.EVENT_READ)
    remaining = 64 * 1024
    until = time.monotonic() + 0.05
    try:
        while probe.select(0):
            if remaining <= 0 or time.monotonic() >= until:
                return False
            chunk = os.read(0, min(remaining, 4096))
            if not chunk:
                return False
            remaining -= len(chunk)
        return True
    finally:
        probe.close()

# Frames queued for the runtime before the helper stops reading the command's
# output. The command then blocks on its own pipe writes until the runtime
# catches up (backpressure), instead of fast output failing the whole job.
OUTPUT_HIGH_WATER = 64 * 1024
# After the command's processes are gone, how long remaining output and the
# exit frame may wait for a slow runtime before cleanup is reported unconfirmed.
OUTPUT_FINAL_DRAIN_SECONDS = 30

class OutputRelay:
    """Newline-delimited JSON frames to the runtime over a non-blocking fd."""
    def __init__(self, fd=1):
        self.fd = fd
        self.pending = bytearray()
    def emit(self, value):
        self.pending.extend(json.dumps(value, separators=(",", ":")).encode() + b"\n")
    @property
    def full(self):
        return len(self.pending) >= OUTPUT_HIGH_WATER
    def flush(self):
        if self.pending:
            try:
                del self.pending[:os.write(self.fd, self.pending)]
            except BlockingIOError:
                pass
    def wait_below_high_water(self, until):
        """Block, at most until `until`, while too much output is queued."""
        while self.full:
            remaining = until - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("job output transport stalled")
            select.select([], [self.fd], [], min(remaining, 0.5))
            self.flush()

# Rootless Podman moves itself into a scope of the runtime user's systemd
# session when it does not own its cgroup, i.e. out of the job's root-owned
# scope. Without a reachable user bus it stays; with cgroupfs it needs none.
NO_USER_BUS = "unix:path=/dev/null/cocalc-no-user-bus"

def launcher_config(config):
    args, env = config["args"], config["env"]
    if (not isinstance(args, list) or not args or args[0] != "exec" or
        not all(isinstance(x, str) and "\0" not in x for x in args) or
        not isinstance(env, dict) or
        not all(isinstance(k, str) and isinstance(v, str) and
                re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) and "\0" not in v
                for k, v in env.items())):
        raise ValueError("invalid launcher configuration")
    # Enforced here, not trusted from the caller.
    return args, dict(env, DBUS_SESSION_BUS_ADDRESS=NO_USER_BUS)

class ProjectRestarted(RuntimeError):
    pass

# Host maintenance (e.g. the I/O policy reconcile) can hold the lifecycle lock
# for a minute or more. Admission waits it out instead of failing the command.
ADMISSION_LOCK_WAIT_SECONDS = 120

def admission_wait(deadline):
    return max(0, min(ADMISSION_LOCK_WAIT_SECONDS, deadline - time.monotonic()))

def rejection_reason(error):
    # Fixed codes only: privileged diagnostics never reach the runtime.
    if isinstance(error, LifecycleBusy):
        return "host-busy"
    if isinstance(error, AdmissionBlocked):
        return "project-not-running"
    if isinstance(error, ProjectRestarted):
        return "project-restarted"
    if isinstance(error, AdmissionCancelled):
        return "cancelled"
    if isinstance(error, ValueError):
        return "invalid-request"
    return "admission-failed"

def reject(error):
    # Only before the scope exists, so no process was launched. Without this
    # frame the runtime could not tell a refusal from an unconfirmed cleanup.
    frame = json.dumps({"type": "rejected", "reason": rejection_reason(error)}).encode() + b"\n"
    try:
        os.write(1, frame)
    except OSError:
        pass

def supervise(project, job, owner, timeout_ms):
    admitted = time.monotonic()
    try:
        if not re.fullmatch(UUID, project) or not re.fullmatch(UUID, job):
            raise ValueError("invalid job identity")
        if not 0 < timeout_ms <= 86400000:
            raise ValueError("invalid deadline")
        deadline = admitted + timeout_ms / 1000
        account = pwd.getpwnam(RUNTIME_USER)
        if account.pw_uid == 0 or account.pw_gid == 0:
            raise ValueError("managed jobs require an unprivileged runtime account")
        if Path(f"/proc/{owner}").stat().st_uid != account.pw_uid:
            raise ValueError("job owner is not the runtime user")
        owner_start = identity(owner)
        with lifecycle_lock(admission_wait(deadline), cancelled=stdin_closed):
            generation = active_state(project)["generation"]
        args, env = launcher_config(config_from_stdin())
    except Exception as error:
        reject(error)
        raise
    parent = POOL / ("project-" + project)
    # Kernel-owned directory name is durable reaper metadata, including the
    # monotonic hard deadline. A SIGSTOP'ed but live guard cannot renew it.
    scope = parent / f"job-{owner}-{owner_start}-{os.getpid()}-{identity(os.getpid())}-{int(deadline * 1000)}-{job}"
    child = None
    completed = False
    pipes = []
    sel = selectors.DefaultSelector()
    relay = OutputRelay(1)
    emit, flush = relay.emit, relay.flush
    background_warning = BackgroundWarningTracker()
    stopped = False
    result = 1
    final_until = None
    # Set just before the scope is created; until then nothing can need cleanup.
    attempted = False
    rejection = None
    def stop(*_):
        nonlocal stopped
        stopped = True
    def emit_output(stream, chunk):
        background_warning.observe(stream, chunk)
        emit({"type": "output", "stream": stream,
              "data": base64.b64encode(chunk).decode("ascii")})
    os.set_blocking(1, False)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        with lifecycle_lock(admission_wait(deadline),
                            cancelled=lambda: stopped or stdin_closed()):
            reap_project_locked(project)
            if active_state(project)["generation"] != generation:
                raise ProjectRestarted("project generation changed before admission")
            # Observe cancellation after the sweep/lock wait, not before it.
            if stopped or time.monotonic() >= deadline or not alive(owner, owner_start) or not lease_connected():
                result = 130
                return
            attempted = True
            scope.mkdir(mode=0o755)
            if not (scope / "cgroup.kill").exists():
                raise RuntimeError("atomic job cancellation unavailable")
            # Publish the root-owned identity before creating any process. The
            # short write is atomic (PIPE_BUF); failure prevents launch. Readers
            # can later check absence under this same lock: this invocation never
            # creates the scope again, even if its final cleanup frame is lost.
            identity_frame = json.dumps({"type": "scope", "scope": scope.name}).encode() + b"\n"
            if os.write(1, identity_frame) != len(identity_frame):
                raise RuntimeError("job identity transport failed")
            for _ in range(3):
                pipes.append(os.pipe())
            child = launch_locked(scope, account, args, env, pipes)
        os.close(pipes[0][0])
        os.close(pipes[1][1])
        os.close(pipes[2][1])
        heartbeat = pipes[0][1]
        os.set_blocking(heartbeat, False)
        sel.register(0, selectors.EVENT_READ, "lease")
        for fd, stream in [(pipes[1][0], "stdout"), (pipes[2][0], "stderr")]:
            os.set_blocking(fd, False)
            sel.register(fd, selectors.EVENT_READ, stream)
        last_lease = last_beat = time.monotonic()
        while not stopped:
            now = time.monotonic()
            # A dead owner is caught by alive() at once; the lease only covers
            # a live but unresponsive one. Its event loop can stall for many
            # seconds under I/O pressure (16 s on wstein, 2026-10-30), which
            # with a 5 s lease killed the command and left its cleanup unproven.
            if now >= deadline or now - last_lease >= 30 or not alive(owner, owner_start):
                stopped = True
                break
            # The in-project supervisor is defense in depth, not the boundary.
            if now - last_beat >= 1:
                try:
                    os.write(heartbeat, b".\n")
                except (BrokenPipeError, BlockingIOError):
                    pass
                last_beat = now
            if relay.full:
                # Backpressure: leave the command's pipes unread, so it blocks
                # on its writes, until the runtime reads the queued frames.
                # Lease, heartbeat, deadline and exit checks continue.
                readable, _, _ = select.select([0], [relay.fd], [], 0.05)
                if readable:
                    if not os.read(0, 4096):
                        stopped = True
                    last_lease = time.monotonic()
            else:
                for key, _ in sel.select(0.05):
                    chunk = os.read(key.fd, 4096)
                    if key.data == "lease":
                        if not chunk:
                            stopped = True
                        last_lease = time.monotonic()
                    elif chunk:
                        emit_output(key.data, chunk)
                    else:
                        sel.unregister(key.fd)
            flush()
            pid, status = os.waitpid(child, os.WNOHANG)
            if pid:
                child = None
                completed = True
                result = os.waitstatus_to_exitcode(status)
                break
        if stopped:
            result = 130
    except Exception as error:
        if not attempted:
            rejection = error
        raise
    finally:
        # Even success kills detached leftovers. Do not report success until
        # populated=0 AND rmdir confirm that there is no remaining authority.
        final_until = time.monotonic() + OUTPUT_FINAL_DRAIN_SECONDS
        try:
            leftovers = 0
            # Before the scope was attempted there is nothing to kill, so do not
            # wait for the lock again (it may be why admission failed).
            if attempted:
                with lifecycle_lock():
                    leftovers = live_scope_processes(scope) if completed and not stopped else 0
                    kill_scope(scope)
            if child is not None:
                os.waitpid(child, 0)
            for fd in ([pipes[0][0]] + [pair[1] for pair in pipes]) if pipes else []:
                try:
                    os.close(fd)
                except OSError:
                    pass
            # Drain output after all writers have exited, without a lifetime buffer.
            for pair in pipes[1:]:
                fd = pair[0]
                while True:
                    chunk = os.read(fd, 4096)
                    if not chunk:
                        break
                    relay.wait_below_high_water(final_until)
                    emit_output("stdout" if pair is pipes[1] else "stderr", chunk)
                    flush()
            if leftovers and not background_warning.seen:
                note = ("Remaining job processes were terminated when the command exited; "
                        "use cocalc project terminal spawn for persistent services.\n")
                emit({"type": "output", "stream": "stderr",
                      "data": base64.b64encode(note.encode()).decode("ascii")})
            if rejection is not None:
                emit({"type": "rejected", "reason": rejection_reason(rejection)})
            else:
                emit({"type": "exit", "code": result, "cleanup": True})
        except Exception:
            # Leave the cgroup for the independent orphan sweep; no clean exit frame.
            raise RuntimeError("job containment cleanup not confirmed") from None
        finally:
            sel.close()
            until = max(time.monotonic() + 1, final_until or 0)
            while relay.pending and time.monotonic() < until:
                try:
                    flush()
                except BrokenPipeError:
                    break
                time.sleep(0.01)

if __name__ == "__main__":
    try:
        if os.geteuid() != 0:
            raise RuntimeError("requires trusted runtime helper")
        if sys.argv[1:] == ["reap"]:
            reap()
        elif sys.argv[1:] == ["confirm-cleanup"]:
            confirm_cleanup()
        elif len(sys.argv) == 4 and sys.argv[1] == "activate":
            activate(sys.argv[2], int(sys.argv[3]))
        elif len(sys.argv) == 3 and sys.argv[1] in ("begin-stop-locked", "cleanup-locked"):
            require_inherited_lock()
            if sys.argv[1] == "begin-stop-locked":
                begin_stop_locked(sys.argv[2])
            else:
                cleanup_locked(sys.argv[2])
        elif len(sys.argv) == 6 and sys.argv[1] == "run":
            supervise(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]))
        else:
            raise ValueError("invalid helper operation")
    except Exception:
        print("Managed job containment unavailable or cleanup unconfirmed", file=sys.stderr)
        sys.exit(1)
