/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import centralLog from "@cocalc/database/postgres/central-log";
import type {
  BrowserAutomationCentralAuditEvent,
  BrowserAutomationCentralAuditValue,
} from "@cocalc/conat/service/browser-session";

const logger = getLogger("server:conat:api:browser-automation-audit");
const BROWSER_AUTOMATION_CENTRAL_AUDIT_EVENTS = new Set<string>([
  "browser_raw_exec_allowed",
  "browser_raw_exec_denied",
  "browser_async_exec_denied",
  "browser_quickjs_host_action_denied",
]);

export type BrowserAutomationAuditValue = BrowserAutomationCentralAuditValue & {
  account_id?: string | null;
};

function optionalString(value: unknown, maxLength: number): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function normalizeBrowserAutomationAuditValue(
  value: BrowserAutomationAuditValue,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    source: "browser-session",
  };
  const account_id = optionalString(value.account_id, 80);
  if (account_id) normalized.account_id = account_id;
  const browser_id = optionalString(value.browser_id, 120);
  if (browser_id) normalized.browser_id = browser_id;
  const project_id = optionalString(value.project_id, 80);
  if (project_id) normalized.project_id = project_id;
  const kind = optionalString(value.kind, 40);
  if (kind) normalized.kind = kind;
  const decision = optionalString(value.decision, 20);
  if (decision) normalized.decision = decision;
  const posture = optionalString(value.posture, 20);
  if (posture) normalized.posture = posture;
  const mode = optionalString(value.mode, 30);
  if (mode) normalized.mode = mode;
  const action_name = optionalString(value.action_name, 80);
  if (action_name) normalized.action_name = action_name;
  const reason = optionalString(value.reason, 512);
  if (reason) normalized.reason = reason;
  const origin = optionalString(value.origin, 512);
  if (origin) normalized.origin = origin;
  return normalized;
}

export async function recordBrowserAutomationAuditEvent({
  event,
  value,
}: {
  event: BrowserAutomationCentralAuditEvent;
  value: BrowserAutomationAuditValue;
}): Promise<void> {
  if (!BROWSER_AUTOMATION_CENTRAL_AUDIT_EVENTS.has(event)) {
    throw Error(`invalid browser automation audit event '${event}'`);
  }
  try {
    await centralLog({
      event,
      value: normalizeBrowserAutomationAuditValue(value),
    });
  } catch (err) {
    logger.warn("failed to write browser automation audit event", {
      event,
      err: `${err}`,
    });
  }
}
