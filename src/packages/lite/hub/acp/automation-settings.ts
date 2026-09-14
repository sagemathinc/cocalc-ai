import { randomUUID } from "node:crypto";
import type { AcpJobRequest } from "@cocalc/conat/ai/acp/types";
import {
  getAcpAutomationById,
  type AcpAutomationRow,
} from "../sqlite/acp-automations";
import { getAcpDatabase } from "../sqlite/acp-database";

// Keep settings revisions independent of updated_at: status/ack writes are
// deliberately not responsibility-changing human settings saves.
export function automationSettingsRevision(row: AcpAutomationRow): string {
  return row.settings_revision || `legacy:${row.created_at}`;
}

// Admission and enqueue must serialize with settings saves in other workers.
// This is the existing ACP database, not another queue or authority store.
export function withCurrentAutomationSettings<T>(
  request: AcpJobRequest,
  enqueue: () => T,
): T {
  const db = getAcpDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    assertAutomationRequestCurrent(
      request,
      getAcpAutomationById(request.chat!.automation_id!),
    );
    const result = enqueue();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function humanAutomationSettings(accountId: string): {
  account_id: string;
  settings_revision: string;
} {
  if (!accountId?.trim())
    throw new Error("Authenticated human account required");
  return { account_id: accountId, settings_revision: randomUUID() };
}

export function assertAutomationRequestCurrent(
  request: AcpJobRequest,
  current?: AcpAutomationRow,
): void {
  if (!request.chat?.automation_id) return;
  if (
    !current ||
    current.automation_id !== request.chat.automation_id ||
    current.project_id !== request.project_id ||
    current.path !== request.chat.path ||
    current.thread_id !== request.chat.thread_id ||
    current.account_id !== request.account_id ||
    automationSettingsRevision(current) !== request.chat.automation_revision
  ) {
    throw new Error(
      "Automation settings changed; stale queued run was not executed",
    );
  }
}
