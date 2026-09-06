#!/usr/bin/env python3
"""Real cgroup/lease fault tests. Refuses anything except a marked CI runner."""
import json
import hashlib
import os
import pwd
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from types import SimpleNamespace
from unittest import mock
import uuid

import bootstrap


FAKE_RUSTIC = r'''#!/usr/bin/python3 -I
import json
import os
from pathlib import Path
import signal
import sys
import time
if "version" in sys.argv:
    print(json.dumps({"schema_version": 1, "capabilities": {
        "strict_backup": True, "strict_restore": True, "sparse_required_restore": True,
        "hole_aware_backup": True, "backup_inventory": 1, "backup_admission": 1,
        "strict_local_metadata": 1, "backup_exclusion_inventory": 1}}))
    sys.exit(0)
if "repoinfo" in sys.argv or "init" in sys.argv:
    sys.exit(0)
mode = Path("mode").read_text()
Path("started").write_text(json.dumps({"pid": os.getpid(), "worker": os.getppid()}))
Path("cgroup").write_text(Path("/proc/self/cgroup").read_text())
Path("invocation").write_text(json.dumps(sys.argv))
if mode == "evidence":
    if "backup-inventory" in sys.argv:
        header = {"schema_version": 1, "type": "header",
            "exclude_larger_than_bytes": "4", "max_report_bytes": "8192",
            "sources": [{"encoding": "unix-bytes-hex", "value": "2e"}],
            "save_options": {}}
        print(json.dumps(header))
        print(json.dumps({"schema_version": 1, "type": "excluded", "reason": "apparent_size",
            "path": {"encoding": "unix-bytes-hex", "value": "737061727365"}, "apparent_bytes": "8",
            "file_version": {"inode": "123", "mtime_ns": "1", "ctime_ns": "2", "mode": 33188, "uid": 1000, "gid": 1000}}))
        print(json.dumps({"schema_version": 1, "type": "complete", "inventory": {
            "excluded_files": "1", "excluded_apparent_bytes": "8", "inspected_entries": "1",
            "inspected_node_metadata_bytes": "100", "inspected_max_path_depth": "1",
            "retained": {name: "0" for name in ["entries", "files", "apparent_bytes",
                "chunk_references_bound", "content_reference_bytes_bound", "node_metadata_bytes", "max_path_depth"]}}}))
    else:
        print(json.dumps({"id": "b" * 64, "time": "2026-09-05T00:00:00Z", "summary": {}}))
    sys.exit(0)
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
    wrapper = Path("/usr/local/sbin/cocalc-runtime-storage")
    policy_path = Path("/etc/cocalc/rustic-job-policy.json")
    io_helper = Path("/usr/local/libexec/cocalc-project-io-policy")
    io_policy = Path("/etc/cocalc/project-io-policy.json")
    slice_unit = Path("/etc/systemd/system/cocalcmaintenance.slice")
    retry_root = Path("/var/lib/cocalc-rustic-jobs")
    report_root = Path("/var/lib/cocalc-rustic-reports")
    root = Path("/mnt/cocalc/rustic-job-qualification")
    for path in [helper, path_helper, binary, wrapper, policy_path, io_helper, io_policy, slice_unit,
                 Path("/etc/cocalc/project-io-policy.override.json"),
                 Path("/sys/fs/cgroup/cocalcmaintenance.slice"),
                 Path("/sys/fs/cgroup/cocalc-maintenance"), retry_root, report_root, root]:
        assert not os.path.lexists(path), f"refusing to replace existing {path}"
    try:
        pwd.getpwnam("cocalc-host")
    except KeyError:
        pass
    else:
        raise AssertionError("refusing to alter an existing cocalc-host account")
    created_host_user = False
    api = {"__name__": "test_job"}
    exec(bootstrap.RUSTIC_JOB_HELPER, api)
    profiles = []
    processes = []
    native_mount = root / "native-btrfs"
    native_mounted = False

    def install(path, content, mode):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("x") as file:
            file.write(content)
        path.chmod(mode)

    def profile(name):
        path = Path("/mnt/cocalc/data/secrets/rustic") / f"project-{uuid.uuid4()}.toml"
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

    def start(name, mode, profile_name, through_sudo=False, immutable=False, captured=False):
        case = (native_mount if immutable else root) / name
        if immutable:
            subprocess.run(["btrfs", "subvolume", "create", str(case)], check=True, capture_output=True)
            events = root / ("events-" + name)
            events.mkdir()
            for filename in ["started", "descendant", "invocation", "cgroup"]:
                (case / filename).symlink_to(events / filename)
        else:
            case.mkdir()
        (case / "mode").write_text(mode)
        if captured:
            assert immutable
            source = case.with_name("source-" + case.name)
            case.rename(source)
            subprocess.run(["btrfs", "subvolume", "snapshot", "-r", str(source), str(case)], check=True, capture_output=True)
        elif immutable:
            subprocess.run(["btrfs", "property", "set", "-ts", str(case), "ro", "true"], check=True)
        command = [str(helper), "run", *args(case, profile_name)]
        if through_sudo:
            command = ["/usr/sbin/runuser", "-u", "runner", "--", "/usr/bin/sudo", "-n", str(wrapper),
                       "project-rustic-backup-supervised", str(case),
                       "/mnt/cocalc/" + profile_name, "qualification"]
        proc = subprocess.Popen(command,
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
        subprocess.run(["useradd", "--system", "--no-create-home", "--user-group", "cocalc-host"], check=True)
        created_host_user = True
        install(helper, bootstrap.RUSTIC_JOB_HELPER, 0o755)
        install(path_helper, bootstrap.RUNTIME_STORAGE_PATH_HELPER, 0o755)
        install(binary, FAKE_RUSTIC, 0o755)
        install(io_helper, bootstrap.PROJECT_IO_POLICY_HELPER, 0o755)
        install(slice_unit, bootstrap.RUSTIC_MAINTENANCE_SLICE, 0o644)
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        native_disk = root / "native.img"
        with native_disk.open("xb") as file:
            file.truncate(512 * 1024**2)
        native_mount.mkdir()
        subprocess.run(["mkfs.btrfs", "-q", str(native_disk)], check=True)
        subprocess.run(["mount", "-o", "loop", str(native_disk), str(native_mount)], check=True)
        native_mounted = True
        limits = {"rbps": 100 * 1024**2, "wbps": 100 * 1024**2, "riops": 10000, "wiops": 10000}
        io_config = {"version": 1, "mode": "enforce", "mountpoint": str(native_mount),
                     "pool": limits, "leafClasses": {"standard": {**limits, "weight": 100}}}
        install(io_policy, json.dumps(io_config), 0o644)
        captured = {}
        with mock.patch.object(bootstrap, "text_write_atomic", side_effect=lambda path, data, **_: captured.__setitem__(str(path), data)), \
             mock.patch.object(bootstrap.os, "chown"), mock.patch.object(bootstrap.os, "chmod"), \
             mock.patch.object(bootstrap, "write_project_io_configuration"):
            bootstrap.install_privileged_wrappers(SimpleNamespace(ssh_user="runner", container_runtime_bundle=None))
        install(wrapper, captured[str(wrapper)], 0o755)
        # Numeric values are only adversarial test budgets, not fleet policy.
        policy = {
            "version": 1, "runtime_seconds": 8, "kill_grace_seconds": 2,
            "memory_bytes": 128 * 1024**2, "cpu_quota_percent": 100,
            "io_weight": 10, "max_jobs": 1, "tasks_max": 64,
        }
        install(policy_path, json.dumps(policy), 0o600)
        shared = profile("shared")
        separate = profile("separate")
        # Observational/disabled I/O policy must not silently grant an uncapped
        # service. Rejection happens before the fake repository binary executes.
        io_policy.write_text(json.dumps({**io_config, "mode": "observe"}))
        rejected, proc = start("no-io-enforcement", "normal", shared)
        result(proc, False)
        assert not (rejected / "started").exists()
        io_policy.write_text(json.dumps(io_config))
        case, proc = start("normal", "normal", shared)
        assert json.loads(result(proc, True)[0])["ok"]
        assert (case / "cgroup").read_text().startswith("0::/cocalcmaintenance.slice/cocalc-rustic-")
        api["check_maintenance_cgroup"]()
        barrier(case, shared)
        _case, proc = start("failure", "failure", shared)
        result(proc, False)

        case, proc = start("sudo-normal", "normal", shared, through_sudo=True)
        assert json.loads(result(proc, True)[0])["ok"]
        subprocess.run([str(wrapper), "project-rustic-backup-wait", str(case),
                        "/mnt/cocalc/" + shared, "qualification"], check=True, timeout=35)

        case, proc = start("sudo-caller-death", "hang", shared, through_sudo=True)
        identity = await_started(case, proc)
        proc.kill()
        proc.wait(timeout=5)
        subprocess.run([str(wrapper), "project-rustic-backup-wait", str(case),
                        "/mnt/cocalc/" + shared, "qualification"], check=True, timeout=35)
        assert_gone(identity, immediate=True)
        proc.communicate(timeout=5)

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
        for pid in [identity["worker"], identity["pid"]]:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        proc.kill()
        proc.wait(timeout=5)
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
        # Exercise the actual old maintenance wrapper too. It must join a
        # systemd scope under the SAME aggregate parent, not a second budget.
        legacy = root / "legacy-maintenance"
        legacy.mkdir()
        (legacy / "mode").write_text("normal")
        completed = subprocess.run([str(wrapper), "project-rustic-backup-maintenance",
                                   str(legacy), "/mnt/cocalc/" + shared, "qualification"],
                                  check=True, capture_output=True, text=True, timeout=30)
        assert json.loads(completed.stdout)["ok"]
        assert (legacy / "cgroup").read_text().startswith("0::/cocalcmaintenance.slice/cocalc-maintenance-")
        assert not Path("/sys/fs/cgroup/cocalc-maintenance").exists()
        policy["native"] = {
            "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
            "admission": {"max-entries": 100, "max-apparent-bytes": 2**30,
                "max-file-bytes": 2**29, "max-chunk-references": 16,
                "max-metadata-bytes": 2**20, "max-path-depth": 20,
                "preflight-timeout-seconds": 2},
        }
        policy_path.write_text(json.dumps(policy))
        mutable, proc = start("mutable-native-source", "normal", shared, through_sudo=True)
        result(proc, False)
        assert not (mutable / "started").exists()
        case, proc = start("native-backup", "normal", shared, through_sudo=True, immutable=True)
        result(proc, True)
        flags = json.loads((case / "invocation").read_text())
        assert "--strict" in flags
        for name, value in policy["native"]["admission"].items():
            assert flags[flags.index("--" + name) + 1] == str(value)
        barrier(case, shared)
        subprocess.run([str(wrapper), "project-rustic-restore-supervised",
                        "/mnt/cocalc/" + shared, "abc123", str(case)], check=True, timeout=30)
        flags = json.loads((case / "invocation").read_text())
        assert "--strict" in flags and flags[flags.index("--sparse") + 1] == "by-content-required"
        subprocess.run([str(wrapper), "rootfs-rustic-backup-supervised",
                        str(case), "/mnt/cocalc/" + shared, "rootfs-qualification"],
                       check=True, timeout=30)
        subprocess.run([str(wrapper), "rootfs-rustic-backup-wait",
                        str(case), "/mnt/cocalc/" + shared, "rootfs-qualification"],
                       check=True, timeout=30)
        flags = json.loads((case / "invocation").read_text())
        assert "--strict" in flags and "--max-chunk-references" in flags
        subprocess.run([str(wrapper), "rootfs-rustic-restore-supervised",
                        "/mnt/cocalc/" + shared, "abc123", str(case), "--delete"],
                       check=True, timeout=30)
        subprocess.run([str(wrapper), "rootfs-rustic-restore-wait",
                        "/mnt/cocalc/" + shared, "abc123", str(case), "--delete"],
                       check=True, timeout=30)
        flags = json.loads((case / "invocation").read_text())
        assert "--strict" in flags and "--delete" in flags and flags[flags.index("--sparse") + 1] == "by-content-required"
        # Real Btrfs identity and root permissions, with a deterministic fixture
        # process. This does not replace real Rustic content/quota qualification.
        policy["native"]["evidence"] = {"policy_version": 1, "exclude_larger_than_bytes": 4,
            "max_report_bytes": 8192, "max_spool_bytes": 16384, "max_reports": 2}
        policy_path.write_text(json.dumps(policy))
        case, proc = start("evidence-not-snapshot", "evidence", shared, through_sudo=True, immutable=True)
        result(proc, False)
        assert not (case / "started").exists()
        case, proc = start("protected-evidence", "evidence", shared, through_sudo=True, immutable=True, captured=True)
        proof = json.loads(result(proc, True)[0])["cocalc_backup_evidence"]
        path_api = {"__name__": "path_qualification"}
        exec(bootstrap.RUNTIME_STORAGE_PATH_HELPER, path_api)
        fd = os.open(case, os.O_RDONLY | os.O_DIRECTORY)
        try:
            expected_source = path_api["btrfs_backup_identity"](fd)
        finally:
            os.close(fd)
        for key, value in expected_source.items():
            assert proof["source"][key] == value
        source = case.with_name("source-" + case.name)
        shown = subprocess.check_output(["btrfs", "subvolume", "show", str(source)], text=True)
        assert proof["source"]["subvolume_uuid"] in shown
        shown = subprocess.check_output(["btrfs", "subvolume", "show", str(case)], text=True)
        assert proof["source"]["snapshot_uuid"] in shown
        assert proof["outcome"] == "partial_policy_exclusions" and proof["excluded_files"] == "1"
        report = Path(proof["report_path"])
        assert report.parent == report_root
        assert report.stat().st_uid == 0 and report.stat().st_gid == pwd.getpwnam("cocalc-host").pw_gid
        assert report.stat().st_mode & 0o777 == 0o440
        assert len(report.read_bytes()) == proof["report"]["bytes"] < 8192
        digest = hashlib.sha256(report.read_bytes()).hexdigest()
        assert proof["report"]["sha256"] == digest
        assert os.getxattr(report, path_api["REPORT_SEAL"]) == digest.encode("ascii")
        bad_release = subprocess.run([str(wrapper), "rustic-report-release", report.name, "0" * 64], capture_output=True, timeout=15)
        assert bad_release.returncode != 0 and report.exists()
        for _ in range(2):
            subprocess.run([str(wrapper), "rustic-report-release", report.name, digest], check=True, timeout=15)
        assert not report.exists()
        assert list(report_root.iterdir()) == [report_root / ".lock"]
        policy["native"].pop("evidence")
        policy["native"]["binary_sha256"] = "0" * 64
        policy_path.write_text(json.dumps(policy))
        case, proc = start("wrong-binary", "normal", shared, through_sudo=True, immutable=True)
        result(proc, False)
        assert not (case / "started").exists()
        barrier(case, shared)
        # Each command below starts a fresh helper process. Retry state must
        # survive those restarts and cannot be bypassed by a new staging path.
        policy.pop("native")
        policy["retry"] = {"base_seconds": 5, "max_seconds": 5, "review_after_failures": 2}
        policy_path.write_text(json.dumps(policy))
        retry_profile = profile("retry")
        case, proc = start("retry-failure-one", "failure", retry_profile)
        result(proc, False)
        blocked, proc = start("retry-too-soon", "normal", retry_profile)
        assert "RUSTIC_RETRY_DEFERRED" in result(proc, False)[1]
        assert not (blocked / "started").exists()
        time.sleep(6)
        case, proc = start("retry-failure-two", "failure", retry_profile)
        result(proc, False)
        blocked, proc = start("retry-review", "normal", retry_profile)
        assert "RUSTIC_OPERATOR_REVIEW_REQUIRED" in result(proc, False)[1]
        assert not (blocked / "started").exists()
        status = json.loads(subprocess.check_output([str(helper), "retry-status", *args(case, retry_profile)], text=True))
        assert status["state"]["failures"] == 2
        assert status["state"]["reason"] == "job_failed"
        reset = json.loads(subprocess.check_output([str(helper), "retry-reset", *args(case, retry_profile)], text=True))
        assert reset["state"]["reason"] == "operator_reset"
        case, proc = start("retry-after-reset", "normal", retry_profile)
        result(proc, True)
        status = json.loads(subprocess.check_output([str(helper), "retry-status", *args(case, retry_profile)], text=True))
        assert status["state"]["phase"] == "complete" and status["state"]["failures"] == 0
        case, proc = start("retry-launcher-death", "hang", retry_profile)
        identity = await_started(case, proc)
        reset = subprocess.run([str(helper), "retry-reset", *args(case, retry_profile)], capture_output=True, timeout=10)
        assert reset.returncode != 0
        proc.kill()
        proc.wait(timeout=5)
        barrier(case, retry_profile)
        assert_gone(identity, immediate=True)
        proc.communicate(timeout=5)
        blocked, proc = start("retry-after-crash", "normal", retry_profile)
        assert "RUSTIC_RETRY_DEFERRED" in result(proc, False)[1]
        assert not (blocked / "started").exists()
        status = json.loads(subprocess.check_output([str(helper), "retry-status", *args(case, retry_profile)], text=True))
        assert status["state"]["reason"] == "job_interrupted" and status["state"]["failures"] == 1
        print(json.dumps({"ok": True, "cases": ["normal", "failure", "deadline",
              "sudo-normal", "sudo-caller-death", "caller-death", "closed-fds",
              "worker-death", "same-repo", "host-full", "orphan", "oom",
              "mutable-native-source", "native-backup", "native-restore", "wrong-binary",
              "no-io-enforcement", "shared-maintenance-parent",
              "rootfs-native-backup", "rootfs-native-restore", "persistent-retry-backoff",
              "persistent-retry-review", "operator-retry-reset", "interrupted-retry-recovery",
              "evidence-requires-snapshot", "protected-evidence-identity", "sealed-report-release"]}))
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
        # Leases/deadlines still apply if an assertion interrupted the test.
        time.sleep(12)
        subprocess.run(["systemctl", "stop", "cocalcmaintenance.slice"], check=True, timeout=15)
        if native_mounted:
            subprocess.run(["umount", str(native_mount)], check=True, timeout=15)
        for path in [helper, path_helper, binary, wrapper, policy_path, io_helper, io_policy, slice_unit, *profiles]:
            path.unlink(missing_ok=True)
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        shutil.rmtree(root)
        if retry_root.exists():
            shutil.rmtree(retry_root)
        if report_root.exists():
            shutil.rmtree(report_root)
        if created_host_user:
            subprocess.run(["userdel", "cocalc-host"], check=True)


if __name__ == "__main__":
    main()
