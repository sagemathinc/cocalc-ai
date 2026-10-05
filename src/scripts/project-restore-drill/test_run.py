import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from run import Drill, save

PID = "11111111-1111-4111-8111-111111111111"
HOST = "22222222-2222-4222-8222-222222222222"
REPO = "33333333-3333-4333-8333-333333333333"
OWNER = "44444444-4444-4444-8444-444444444444"
BACKUP = "55555555-5555-4555-8555-555555555555"
RESTORE = "66666666-6666-4666-8666-666666666666"
DELETE = "77777777-7777-4777-8777-777777777777"
ITEM = dict(planned_project_id=PID, host_id=HOST, backup_repo_id=REPO, region="test")


class FakeDrill(Drill):
    """Exercise the real workflow and checkpoints without production operations."""

    def __init__(self, args, item=ITEM):
        super().__init__(args, item)
        self.calls = []
        self.mismatch = False
        self.remote_only = True
        self.runtime_state = "opened"
        self.fail = None
        self.bad_canary = False
        self.bad_reservation = False
        self.failed_operation = None

    def cli(self, label, *args):
        self.calls.append((label, args))
        if self.fail == label:
            raise RuntimeError(label + ": unconfirmed outcome")
        if label in ("reservation", "canary-check"):
            bad = self.bad_reservation if label == "reservation" else self.bad_canary
            return {"row_count": 0 if bad else 1}
        if label == "create":
            return {"project_id": PID}
        if label.endswith("-submit"):
            return {
                "op_id": {
                    "backup-submit": BACKUP,
                    "restore-submit": RESTORE,
                    "delete-submit": DELETE,
                }[label]
            }
        if label.endswith("-status"):
            return {
                "status": "failed" if self.failed_operation == label else "succeeded",
                "result": {"id": "snapshot", "remote_only": self.remote_only},
            }
        if label == "download":
            original = (self.directory / "marker.bin").read_bytes()
            (self.directory / "restored-marker.bin").write_bytes(
                b"wrong" if self.mismatch else original
            )
        if label == "attest":
            # Match AdminDbRestoreDrillAttestationResponse, not the internal DB helper.
            return {
                "audit_id": "audit",
                "op_id": RESTORE,
                "project_id": PID,
                "backup_id": "snapshot",
                "bay_id": "bay-test",
                "created": True,
                "evidence_source": "operator_supplied",
                "passed": not self.mismatch,
            }
        if label == "final-project":
            return {"state": self.runtime_state}
        return {}


class DrillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.args = SimpleNamespace(
            campaign_dir=Path(self.temp.name),
            api="https://example.test",
            profile="test",
            owner=OWNER,
            bay="bay-test",
            keep_projects=False,
        )
        self.drill = FakeDrill(self.args)

    def labels(self, drill=None):
        return [label for label, _ in (drill or self.drill).calls]

    def test_success_deletes_after_saving_attestation_and_waits_for_completion(self):
        result = self.drill.run()
        self.assertTrue(result["complete"])
        self.assertEqual(result["cleanup"], "deleted")
        self.assertEqual(result["delete_op_id"], DELETE)
        self.assertLess(
            self.labels().index("attest"), self.labels().index("delete-submit")
        )
        self.assertEqual(self.labels()[-1], "delete-status")
        self.assertEqual(json.loads(self.drill.path.read_text()), result)
        self.assertTrue((self.drill.directory / "restored-marker.bin").exists())
        delete_args = dict(self.drill.calls)["delete-submit"]
        self.assertEqual(delete_args, ("project", "delete", "--project", PID, "--yes"))

    def test_completion_does_not_repeat_any_calls(self):
        self.drill.run()
        resumed = FakeDrill(self.args)
        self.assertTrue(resumed.run()["complete"])
        self.assertEqual(resumed.calls, [])

    def test_explicit_keep_projects_retains_verified_canary(self):
        self.args.keep_projects = True
        result = self.drill.run()
        self.assertTrue(result["complete"])
        self.assertEqual(result["cleanup"], "retained")
        self.assertNotIn("delete-submit", self.labels())

    def test_hash_mismatch_is_attested_but_not_deleted(self):
        self.drill.mismatch = True
        result = self.drill.run()
        self.assertIn("error", result)
        self.assertFalse(result["attestation"]["passed"])
        self.assertNotIn("delete-submit", self.labels())

    def test_local_cache_restore_is_not_attested_or_deleted(self):
        self.drill.remote_only = False
        result = self.drill.run()
        self.assertIn("remote-only", result["error"])
        self.assertNotIn("attest", self.labels())
        self.assertNotIn("delete-submit", self.labels())

    def test_failed_backup_is_retained(self):
        self.drill.failed_operation = "backup-status"
        result = self.drill.run()
        self.assertIn("error", result)
        self.assertNotIn("restore-submit", self.labels())
        self.assertNotIn("delete-submit", self.labels())

    def test_failed_restore_is_retained(self):
        self.drill.failed_operation = "restore-status"
        result = self.drill.run()
        self.assertIn("error", result)
        self.assertNotIn("attest", self.labels())
        self.assertNotIn("delete-submit", self.labels())

    def test_uncertain_attestation_prevents_deletion(self):
        self.drill.fail = "attest"
        result = self.drill.run()
        self.assertEqual(result["submission_pending"], "attest")
        self.assertNotIn("delete-submit", self.labels())

    def test_reservation_is_checked_before_create(self):
        self.drill.bad_reservation = True
        result = self.drill.run()
        self.assertIn("error", result)
        self.assertNotIn("create", self.labels())

    def test_exact_owner_bay_host_and_repository_are_rechecked_before_delete(self):
        self.drill.verify()
        self.drill.calls.clear()
        self.drill.bad_canary = True
        result = self.drill.run()
        self.assertIn("ownership/placement changed", result["error"])
        self.assertEqual(self.labels(), ["canary-check"])
        sql = self.drill.calls[0][1][-1]
        for value in (PID, OWNER, HOST, REPO, "bay-test"):
            self.assertIn(value, sql)

    def test_active_runtime_is_not_deleted(self):
        self.drill.runtime_state = "running"
        result = self.drill.run()
        self.assertIn("active or unknown runtime", result["error"])
        self.assertNotIn("delete-submit", self.labels())

    def test_crash_after_verification_resumes_only_cleanup(self):
        self.drill.verify()
        resumed = FakeDrill(self.args)
        self.assertTrue(resumed.run()["complete"])
        self.assertEqual(
            self.labels(resumed),
            ["canary-check", "final-project", "delete-submit", "delete-status"],
        )

    def test_crash_after_delete_submission_polls_saved_operation_only(self):
        self.drill.verify()
        self.drill.state["delete_op_id"] = DELETE
        self.drill.checkpoint()
        resumed = FakeDrill(self.args)
        self.assertTrue(resumed.run()["complete"])
        self.assertEqual(self.labels(resumed), ["delete-status"])

    def test_keep_projects_cannot_abandon_already_submitted_delete(self):
        self.drill.verify()
        self.drill.state["delete_op_id"] = DELETE
        self.drill.checkpoint()
        self.args.keep_projects = True
        resumed = FakeDrill(self.args)
        self.assertEqual(resumed.run()["cleanup"], "deleted")

    def test_delete_failure_is_not_success_and_is_actionable(self):
        self.drill.failed_operation = "delete-status"
        result = self.drill.run()
        self.assertIn(DELETE, result["error"])
        self.assertTrue(result["verified"])
        self.assertNotIn("complete", result)

    def test_delete_reply_loss_is_checkpointed_and_never_blindly_retried(self):
        self.drill.fail = "delete-submit"
        result = self.drill.run()
        self.assertEqual(result["submission_pending"], "delete-submit")
        self.assertNotIn("complete", result)
        resumed = FakeDrill(self.args)
        with self.assertRaisesRegex(RuntimeError, "reconcile saved outcome") as error:
            resumed.run()
        self.assertIn(str(self.drill.path), str(error.exception))
        self.assertIn(PID, str(error.exception))
        self.assertEqual(resumed.calls, [])

    def test_old_campaign_checkpoint_is_not_implicitly_a_cleanup_target(self):
        save(self.drill.path, {"project_id": PID, "complete": True})
        with self.assertRaisesRegex(RuntimeError, "checkpoint scope differs"):
            FakeDrill(self.args)

    def test_changed_site_owner_or_bay_cannot_reuse_checkpoint(self):
        self.drill.checkpoint()
        for field in ("api", "owner", "bay"):
            args = copy.copy(self.args)
            setattr(args, field, "different")
            with self.assertRaisesRegex(RuntimeError, "checkpoint scope differs"):
                FakeDrill(args)

    def test_changed_saved_marker_is_not_silently_rehashed_on_resume(self):
        self.drill.fail = "backup-submit"
        self.drill.run()
        # Model an operator-reconciled failed submission, then corrupt local evidence.
        self.drill.state.pop("error")
        self.drill.state.pop("submission_pending")
        self.drill.checkpoint()
        (self.drill.directory / "marker.bin").write_bytes(b"changed")
        resumed = FakeDrill(self.args)
        result = resumed.run()
        self.assertIn("saved marker changed", result["error"])
        self.assertNotIn("backup-submit", self.labels(resumed))
        self.assertNotIn("delete-submit", self.labels(resumed))


if __name__ == "__main__":
    unittest.main()
