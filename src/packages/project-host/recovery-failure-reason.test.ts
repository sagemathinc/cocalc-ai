/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { recoveryFailureReason } from "./recovery-failure-reason";

it.each([
  ["snapshot", "Disk quota exceeded", "storage_quota_exceeded"],
  [
    "backup",
    "Managed backup upload limit reached for this account. Reset tomorrow.",
    "managed_backup_egress_policy_blocked",
  ],
  [
    "backup",
    "created backup was not confirmed in the repository",
    "repository_confirmation_failed",
  ],
  [
    "backup",
    "rustic s3 backend: InvalidAccessKeyId; access key secret=do-not-report",
    "repository_credentials_invalid",
  ],
  [
    "backup",
    "rustic object store: ServiceUnavailable (503)",
    "object_store_unavailable",
  ],
] as const)("classifies %s failure as %s", (kind, message, reason) => {
  expect(recoveryFailureReason(new Error(message), kind)).toBe(reason);
});

it("does not claim a generic permission error is a repository credential failure", () => {
  expect(
    recoveryFailureReason(new Error("AccessDenied"), "backup"),
  ).toBeUndefined();
  expect(recoveryFailureReason(new Error("503"), "snapshot")).toBeUndefined();
});
