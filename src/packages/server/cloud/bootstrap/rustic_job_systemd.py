#!/usr/bin/env python3
"""Real cgroup/lease fault tests. Refuses anything except a marked CI runner."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

import bootstrap


FAKE_RUSTIC = r'''#!/usr/bin/python3 -I
import json
import os
from pathlib import Path
import signal
import sys
import time
if "repoinfo" in sys.argv or "init" in sys.argv:
    sys.exit(0)
mode = Path("mode").read_text()
Path("started").write_text(json.dumps({"pid": os.getpid(), "worker": os.getppid()}))
if mode == "normal":
    print('{"ok": true}', flush=True)
    sys.exit(0)
if mode == "failure":
    sys.exit(37)
if mode == "memory":
    data = []
    while True:
        data.append(bytearray(8 * 1024**2))
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = os.fork()
if child == 0:
    os.setsid()
    if mode == "closed-fds":
        os.closerange(0, 65536)
    Path("descendant").write_text(str(os.getpid()))
    while True:
        time.sleep(1)
if mode == "orphan":
    while not Path("descendant").exists():
        time.sleep(.01)
    print('{"ok": true}', flush=True)
    sys.exit(0)
print('{"ok": true}', flush=True)
while True:
    time.sleep(1)
'''


def main():
    assert os.geteuid() == 0
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("COCALC_DISPOSABLE_JOB_TEST") == "1"
    assert Path("/run/cocalc-disposable-rustic-job-test").is_file()
    assert Path("/proc/1/comm").read_text().strip() == "systemd"
    helper = Path("/usr/local/libexec/cocalc-rustic-job")
    path_helper = Path("/usr/local/libexec/cocalc-runtime-storage-path-helper")
    binary = Path("/usr/local/libexec/cocalc-rustic")
    policy_path = Path("/etc/cocalc/rustic-job-policy.json")
    root = Path("/mnt/cocalc/rustic-job-qualification")
    for path in [helper, path_helper, binary, policy_path, root]:
        assert not os.path.lexists(path), f"refusing to replace existing {path}"
    api = {"__name__": "test_job"}
    exec(bootstrap.RUSTIC_JOB_HELPER, api)
    profiles = []
    processes = []

    def install(path, content, mode):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("x") as file:
            file.write(content)
        path.chmod(mode)

    def profile(name):
        path = root / f"{name}.toml"
        install(path, '''[repository]
repository = "opendal:s3"
password = "disposable"
[repository.options]
endpoint = "https://example.invalid"
bucket = "qualification"
root = "test"
region = "test"
access_key_id = "disposable"
secret_access_key = "disposable"
''', 0o600)
        profiles.append(path)
        return str(path.relative_to("/mnt/cocalc"))

    def args(case, profile_name):
        return ["rustic-project-backup", "--root", "/mnt/cocalc",
                "--path", str(case.relative_to("/mnt/cocalc")),
                "--profile-root", "/mnt/cocalc", "--profile-path", profile_name,
                "--host", "qualification"]

    def start(name, mode, profile_name):
        case = root / name
        case.mkdir()
        (case / "mode").write_text(mode)
        proc = subprocess.Popen([str(helper), "run", *args(case, profile_name)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(proc)
        return case, proc

    def result(proc, success):
        stdout, stderr = proc.communicate(timeout=30)
        assert (proc.returncode == 0) == success, (proc.returncode, stdout, stderr)
        return stdout, stderr

    def await_started(case, proc):
        deadline = time.monotonic() + 15
        while not (case / "descendant").exists():
            if proc.poll() is not None:
                out, err = proc.communicate()
                raise AssertionError(("job failed before start", out, err))
            assert time.monotonic() < deadline, "job did not start"
            time.sleep(.05)
        identity = json.loads((case / "started").read_text())
        identity["descendant"] = int((case / "descendant").read_text())
        return identity

    def assert_gone(identity, immediate=False):
        deadline = time.monotonic() + 15
        while any(api["process_identity"](pid) is not None for pid in identity.values()):
            assert not immediate and time.monotonic() < deadline, ("process escaped cleanup", identity)
            time.sleep(.1)

    def barrier(case, profile_name):
        subprocess.run([str(helper), "wait", *args(case, profile_name)], check=True, timeout=35)

    try:
        root.mkdir(parents=True)
        install(helper, bootstrap.RUSTIC_JOB_HELPER, 0o755)
        install(path_helper, bootstrap.RUNTIME_STORAGE_PATH_HELPER, 0o755)
        install(binary, FAKE_RUSTIC, 0o755)
        # Numeric values are only adversarial test budgets, not fleet policy.
        install(policy_path, json.dumps({
            "version": 1, "runtime_seconds": 8, "kill_grace_seconds": 2,
            "memory_bytes": 128 * 1024**2, "cpu_quota_percent": 100,
            "io_weight": 10, "max_jobs": 1, "tasks_max": 64,
        }), 0o600)
        shared = profile("shared")
        separate = profile("separate")
        case, proc = start("normal", "normal", shared)
        assert json.loads(result(proc, True)[0])["ok"]
        barrier(case, shared)
        _case, proc = start("failure", "failure", shared)
        result(proc, False)

        case, proc = start("deadline", "hang", shared)
        identity = await_started(case, proc)
        result(proc, False)
        assert_gone(identity)
        barrier(case, shared)

        case, proc = start("caller-death", "hang", shared)
        identity = await_started(case, proc)
        proc.kill()
        proc.wait(timeout=5)
        barrier(case, shared)
        assert_gone(identity, immediate=True)
        proc.communicate(timeout=5)

        case, proc = start("closed-fds", "closed-fds", shared)
        identity = await_started(case, proc)
        proc.kill()
        proc.wait(timeout=5)
        os.kill(identity["worker"], signal.SIGKILL)
        os.kill(identity["pid"], signal.SIGKILL)
        barrier(case, shared)
        assert_gone(identity, immediate=True)
        proc.communicate(timeout=5)

        case, proc = start("worker-death", "hang", shared)
        identity = await_started(case, proc)
        os.kill(identity["worker"], signal.SIGKILL)
        result(proc, False)
        assert_gone(identity)
        barrier(case, shared)

        case, proc = start("occupied", "hang", shared)
        identity = await_started(case, proc)
        duplicate, second = start("same-repo", "normal", shared)
        result(second, False)
        assert not (duplicate / "started").exists()
        other, second = start("host-full", "normal", separate)
        result(second, False)
        assert not (other / "started").exists()
        proc.kill()
        proc.wait(timeout=5)
        barrier(case, shared)
        assert_gone(identity)
        proc.communicate(timeout=5)

        case, proc = start("orphan", "orphan", shared)
        # A "success" JSON followed by forced descendant cleanup is not success.
        result(proc, False)
        assert_gone(json.loads((case / "started").read_text()) | {
            "descendant": int((case / "descendant").read_text())})
        barrier(case, shared)

        case, proc = start("oom", "memory", shared)
        result(proc, False)
        assert_gone(json.loads((case / "started").read_text()))
        barrier(case, shared)
        print(json.dumps({"ok": True, "cases": ["normal", "failure", "deadline",
              "caller-death", "closed-fds", "worker-death", "same-repo", "host-full", "orphan", "oom"]}))
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
        # Leases/deadlines still apply if an assertion interrupted the test.
        time.sleep(12)
        for path in [helper, path_helper, binary, policy_path]:
            path.unlink(missing_ok=True)
        shutil.rmtree(root)


if __name__ == "__main__":
    main()
