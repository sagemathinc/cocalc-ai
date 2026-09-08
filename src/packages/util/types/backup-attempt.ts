/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/** Observational latest-attempt state, never backup or deletion authority.
 * Unconfirmed includes an in-flight job AND a worker that disappeared.
 */
export interface BackupAttemptStatus {
  project_id: string;
  attempt_id: string;
  started_at: string;
  finished_at: string | null;
  outcome: "unconfirmed" | "failed" | "complete" | "partial_policy_exclusions";
  backup_id: string | null;
}

export interface BackupAttemptUpdate {
  host_id?: string;
  project_id: string;
  attempt_id: string;
  action: "start" | "finish";
  // Finish without a snapshot means failure. Otherwise the owning bay derives
  // the outcome from its protected receipt, not a caller-supplied success flag.
  backup_id?: string;
}
