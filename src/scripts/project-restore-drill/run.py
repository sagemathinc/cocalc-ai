"""Remote-only canary drills, with checkpointed deletion after attestation.

Uses the first-party CLI for authorization, owner routing, and lifecycle work.
Repository reservations must already exist; see README.md. No title-based sweep.
"""

import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid


def save(path, value):
    temp = path.with_suffix(".tmp")
    with temp.open("w") as handle:
        handle.write(json.dumps(value, indent=2) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    temp.replace(path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def sql_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def valid_uuid(value):
    if str(uuid.UUID(value)) != value:
        raise ValueError("expected canonical UUID: " + str(value))
    return value


class Drill:
    def __init__(self, args, item):
        for field in ("planned_project_id", "host_id", "backup_repo_id"):
            valid_uuid(item[field])
        self.args = args
        self.directory = args.campaign_dir / "shards" / item["backup_repo_id"]
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "state.json"
        scope = dict(
            item,
            api=args.api,
            owner=args.owner,
            bay=args.bay,
            title="Operator restore drill " + item["planned_project_id"],
        )
        self.state = (
            json.loads(self.path.read_text())
            if self.path.exists()
            else {"scope": scope}
        )
        if self.state.get("scope") != scope:
            raise RuntimeError(
                "checkpoint scope differs from plan/site/owner: " + str(self.path)
            )
        self.scope = scope
        self.pid = item["planned_project_id"]

    def checkpoint(self):
        save(self.path, self.state)

    def cli(self, label, *args):
        argv = [
            self.args.node,
            self.args.cli,
            "--profile",
            self.args.profile,
            "--api",
            self.args.api,
            "--rpc-timeout",
            "60s",
            "--json",
            *args,
        ]
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired as exc:
            # Keep uncertain mutations pending. Never assume a timeout rejected them.
            for suffix, output in (("stdout", exc.stdout), ("stderr", exc.stderr)):
                if isinstance(output, bytes):
                    output = output.decode(errors="replace")
                (self.directory / f"{label}.{suffix}.txt").write_text(output or "")
            raise RuntimeError(
                f"{label}: unconfirmed outcome; inspect {self.directory}"
            ) from exc
        (self.directory / f"{label}.stdout.json").write_text(proc.stdout)
        (self.directory / f"{label}.stderr.txt").write_text(proc.stderr)
        try:
            result = json.loads(proc.stdout)
        except ValueError as exc:
            raise RuntimeError(
                f"{label}: unconfirmed outcome; inspect {self.directory}"
            ) from exc
        if proc.returncode or not result.get("ok"):
            raise RuntimeError(f"{label}: command failed; inspect {self.directory}")
        return result["data"]

    def query(self, label, sql):
        return self.cli(
            label,
            "admin",
            "db",
            "query",
            "--bay",
            self.args.bay,
            "--reason",
            "Verify exact reserved operator restore-drill canary",
            "--sql",
            sql,
        )

    def check_reservation(self):
        s = self.scope
        data = self.query(
            "reservation",
            f"""
            SELECT a.project_id FROM project_backup_repo_assignments a
            JOIN project_hosts h ON h.id={sql_string(s['host_id'])}::uuid
            WHERE a.project_id={sql_string(self.pid)}::uuid
              AND a.backup_repo_id={sql_string(s['backup_repo_id'])}::uuid
              AND a.region={sql_string(s['region'])} AND h.bay_id={sql_string(s['bay'])}
              AND NOT EXISTS (SELECT 1 FROM projects WHERE project_id=a.project_id)
              AND NOT EXISTS (SELECT 1 FROM deleted_projects WHERE project_id=a.project_id)
        """,
        )
        if data.get("row_count") != 1:
            raise RuntimeError(
                "missing reservation or UUID already used; refusing to create canary"
            )

    def check_canary(self):
        s = self.scope
        data = self.query(
            "canary-check",
            f"""
            SELECT p.project_id FROM projects p
            JOIN project_backup_repo_assignments a ON a.project_id=p.project_id
            WHERE p.project_id={sql_string(self.pid)}::uuid
              AND p.title={sql_string(s['title'])}
              AND p.users->{sql_string(s['owner'])}->>'group'='owner'
              AND p.owning_bay_id={sql_string(s['bay'])}
              AND p.host_id={sql_string(s['host_id'])}::uuid
              AND p.region={sql_string(s['region'])} AND p.deleted IS NOT TRUE
              AND a.backup_repo_id={sql_string(s['backup_repo_id'])}::uuid
              AND (p.backup_repo_id IS NULL OR p.backup_repo_id=a.backup_repo_id)
        """,
        )
        if data.get("row_count") != 1:
            raise RuntimeError(
                "canary ownership/placement changed; refusing further work or deletion"
            )

    def submit(self, label, key, *args):
        self.state["submission_pending"] = label
        self.checkpoint()
        data = self.cli(label, *args)
        self.state[key] = valid_uuid(data["op_id"])
        self.state.pop("submission_pending")
        self.checkpoint()

    def check_attestation(self):
        s = self.state
        expected = {
            "op_id": s["restore_op_id"],
            "project_id": self.pid,
            "backup_id": s["backup_id"],
            "backup_repo_id": self.scope["backup_repo_id"],
            "restore_host_id": self.scope["host_id"],
            "expected_sha256": s["expected_sha256"],
            "observed_sha256": s["observed_sha256"],
            "passed": True,
        }
        # The public attestation receipt intentionally omits the repository, host,
        # and hashes. Read the immutable record, not the current project placement.
        data = self.query(
            "attestation-check",
            f"""SELECT op_id, project_id, backup_id, backup_repo_id, restore_host_id,
                       expected_sha256, observed_sha256, passed
                  FROM project_restore_drill_attestations
                 WHERE op_id={sql_string(s['restore_op_id'])}::uuid
                   AND project_id={sql_string(self.pid)}::uuid""",
        )
        rows = data.get("rows", [])
        fields = [field["name"] for field in data.get("fields", [])]
        record = dict(zip(fields, rows[0])) if len(rows) == 1 else {}
        if (
            data.get("row_count") != 1
            or data.get("truncated")
            or record != expected
            or record.get("passed") is not True
            or s["expected_sha256"] != s["observed_sha256"]
        ):
            raise RuntimeError(
                f"immutable attestation mismatch for project {self.pid}, "
                f"operation {s['restore_op_id']}; inspect {self.directory / 'attestation-check.stdout.json'}"
            )
        s["attestation_check"] = data
        self.checkpoint()

    def wait(self, op_id, label):
        deadline = time.monotonic() + 1200
        while time.monotonic() < deadline:
            result = self.cli(label, "op", "get", op_id)
            if result["status"] == "succeeded":
                return result
            if result["status"] in ("failed", "canceled", "cancelled"):
                raise RuntimeError(f"{label}: {result['status']} (operation {op_id})")
            time.sleep(3)
        raise RuntimeError(
            f"{label}: still pending; inspect operation {op_id}; do not resubmit"
        )

    def verify(self):
        s = self.state
        if not s.get("created"):
            self.check_reservation()
            s["submission_pending"] = "create"
            self.checkpoint()
            created = self.cli(
                "create",
                "project",
                "create",
                self.scope["title"],
                "--project-id",
                self.pid,
                "--host",
                self.scope["host_id"],
            )
            if created["project_id"] != self.pid:
                raise RuntimeError("create returned an unexpected project UUID")
            s["created"] = True
            s.pop("submission_pending")
            self.checkpoint()
        self.check_canary()
        marker = self.directory / "marker.bin"
        if not marker.exists():
            if s.get("uploaded"):
                raise RuntimeError(
                    "saved marker is missing; refusing to replace drill evidence"
                )
            marker.write_bytes(os.urandom(4096))
        digest = hashlib.sha256(marker.read_bytes()).hexdigest()
        if s.get("expected_sha256") not in (None, digest):
            raise RuntimeError(
                "saved marker changed; refusing to replace drill evidence"
            )
        s["expected_sha256"] = digest
        self.checkpoint()
        if not s.get("uploaded"):
            self.cli(
                "upload",
                "project",
                "file",
                "put",
                str(marker),
                "restore-drill/marker.bin",
                "--project",
                self.pid,
            )
            s["uploaded"] = True
            self.checkpoint()
        if "backup_op_id" not in s:
            self.submit(
                "backup-submit",
                "backup_op_id",
                "project",
                "backup",
                "create",
                "--project",
                self.pid,
            )
        if "backup_id" not in s:
            s["backup_id"] = self.wait(s["backup_op_id"], "backup-status")["result"][
                "id"
            ]
            self.checkpoint()
        if not s.get("source_removed"):
            self.cli(
                "remove-source",
                "project",
                "file",
                "rm",
                "restore-drill/marker.bin",
                "--project",
                self.pid,
            )
            s["source_removed"] = True
            self.checkpoint()
        if "restore_op_id" not in s:
            self.submit(
                "restore-submit",
                "restore_op_id",
                "project",
                "backup",
                "restore",
                "--project",
                self.pid,
                "--backup-id",
                s["backup_id"],
                "--path",
                "restore-drill/marker.bin",
                "--dest",
                "/home/user/restore-drill/restored-marker.bin",
                "--remote-only",
            )
        restored = self.wait(s["restore_op_id"], "restore-status")
        if restored["result"].get("remote_only") is not True:
            raise RuntimeError("restore did not confirm remote-only execution")
        s["restore_result"] = restored
        observed = self.directory / "restored-marker.bin"
        self.cli(
            "download",
            "project",
            "file",
            "get",
            "restore-drill/restored-marker.bin",
            str(observed),
            "--project",
            self.pid,
        )
        s["observed_sha256"] = hashlib.sha256(observed.read_bytes()).hexdigest()
        self.checkpoint()
        if not s.get("attestation"):
            s["submission_pending"] = "attest"
            self.checkpoint()
            s["attestation"] = self.cli(
                "attest",
                "admin",
                "db",
                "project-restore-drill-attest",
                "--bay",
                self.args.bay,
                "--op-id",
                s["restore_op_id"],
                "--expected-sha256",
                s["expected_sha256"],
                "--observed-sha256",
                s["observed_sha256"],
                "--reason",
                "Reserved disposable canary: original removed, remote-only restore independently downloaded and hashed",
            )
            s.pop("submission_pending")
            self.checkpoint()
        attestation = s["attestation"]
        if (
            s["observed_sha256"] != s["expected_sha256"]
            or attestation.get("passed") is not True
            or attestation.get("project_id") != self.pid
            or attestation.get("op_id") != s["restore_op_id"]
            or attestation.get("backup_id") != s["backup_id"]
            or attestation.get("bay_id") != self.args.bay
        ):
            raise RuntimeError(
                "drill attestation did not confirm this canary; retaining project"
            )
        self.check_attestation()
        s["verified"] = True
        self.checkpoint()

    def cleanup(self):
        s = self.state
        if not s.get("created") or not s.get("verified"):
            raise RuntimeError(
                "refusing cleanup without verified evidence for a created canary"
            )
        if self.args.keep_projects and "delete_op_id" not in s:
            s["cleanup"] = "retained"
            self.checkpoint()
            return
        if "delete_op_id" not in s:
            self.check_canary()
            self.check_attestation()
            project = self.cli("final-project", "project", "get", "--project", self.pid)
            if project.get("state") not in ("opened", "closed"):
                raise RuntimeError(
                    "canary has an active or unknown runtime; refusing deletion"
                )
            # The normal delete API handles owner routing, host cleanup and projections.
            # Keep its default backup retention; immutable attestations are independent.
            self.submit(
                "delete-submit",
                "delete_op_id",
                "project",
                "delete",
                "--project",
                self.pid,
                "--yes",
            )
        s["delete_result"] = self.wait(s["delete_op_id"], "delete-status")
        s["cleanup"] = "deleted"
        self.checkpoint()

    def run(self):
        s = self.state
        if s.get("complete"):
            return s
        if s.get("submission_pending") or s.get("error"):
            raise RuntimeError(
                f"reconcile saved outcome before resume: {self.path}; project {self.pid}"
            )
        try:
            # After verification only cleanup is resumed, never another restore/attestation.
            if not s.get("verified"):
                self.verify()
            self.cleanup()
            s["complete"] = True
            self.checkpoint()
        except Exception as exc:
            s["error"] = str(exc)
            self.checkpoint()
        return s


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign-dir", type=Path, required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--api", required=True)
    parser.add_argument("--owner", type=valid_uuid, required=True)
    parser.add_argument(
        "--bay", required=True, help="authoritative bay of every reserved project/host"
    )
    parser.add_argument("--node", default="/opt/cocalc/bin/node")
    parser.add_argument("--cli", default="/opt/cocalc/bin2/cocalc-cli.js")
    parser.add_argument("--pilot", action="store_true")
    parser.add_argument("--shard", type=valid_uuid)
    parser.add_argument(
        "--keep-projects",
        action="store_true",
        help="explicitly retain successful canaries for debugging",
    )
    args = parser.parse_args()
    os.umask(0o077)
    args.campaign_dir = args.campaign_dir.resolve()
    plan = json.loads((args.campaign_dir / "plan.json").read_text())
    if len({p["planned_project_id"] for p in plan}) != len(plan) or len(
        {p["backup_repo_id"] for p in plan}
    ) != len(plan):
        parser.error("plan must contain unique project and repository UUIDs")
    if args.shard:
        plan = [p for p in plan if p["backup_repo_id"] == args.shard]
    if args.pilot:
        plan = plan[:1]
    if not plan:
        parser.error("no reserved canaries selected")
    # A second runner must not race the mutation checkpoints, even for a pilot.
    with (args.campaign_dir / "runner.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        drills = [Drill(args, item) for item in plan]
        groups = {}
        for drill in drills:
            groups.setdefault(drill.scope["host_id"], []).append(drill)

        def run_host(group):
            results = []
            for drill in group:
                result = drill.run()
                results.append(result)
                if not result.get("complete"):
                    break
            return results

        # At most two hosts in flight, and one drill per host.
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = [
                r for group in pool.map(run_host, groups.values()) for r in group
            ]
        print(
            json.dumps(
                {
                    "planned": len(plan),
                    "complete": sum(bool(r.get("complete")) for r in results),
                    "deleted": sum(r.get("cleanup") == "deleted" for r in results),
                    "retained": sum(r.get("cleanup") == "retained" for r in results),
                    "needs_attention": [
                        {
                            "project_id": r["scope"]["planned_project_id"],
                            "checkpoint": str(
                                args.campaign_dir
                                / "shards"
                                / r["scope"]["backup_repo_id"]
                                / "state.json"
                            ),
                            "error": r.get("error"),
                            "submission_pending": r.get("submission_pending"),
                            "delete_op_id": r.get("delete_op_id"),
                            "cleanup": r.get("cleanup"),
                        }
                        for r in results
                        if not r.get("complete") or r.get("cleanup") == "retained"
                    ],
                }
            )
        )
        return (
            0
            if len(results) == len(plan) and all(r.get("complete") for r in results)
            else 1
        )


if __name__ == "__main__":
    raise SystemExit(main())
