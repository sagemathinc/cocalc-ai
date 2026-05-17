/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import centralLog from "@cocalc/database/postgres/central-log";
import type { ApiKeyCapability } from "@cocalc/util/db-schema/api-keys";

const logger = getLogger("server:api:api-key-audit");

export type ApiKeyAuditEvent =
  | "api_key_created"
  | "api_key_deleted"
  | "api_key_used"
  | "api_key_denied";

export interface ApiKeyAuditValue {
  account_id?: string | null;
  api_key_id?: number | null;
  key_id?: string | null;
  source?: string | null;
  reason?: string | null;
  code?: string | null;
  capability?: ApiKeyCapability | string | null;
  project_id?: string | null;
  rpc?: string | null;
  subject?: string | null;
  conat_operation?: "sub" | "pub" | null;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function normalizeApiKeyAuditValue(
  value: ApiKeyAuditValue,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    source: optionalString(value.source, 80) ?? "unknown",
  };
  const account_id = optionalString(value.account_id, 80);
  if (account_id) normalized.account_id = account_id;
  if (
    typeof value.api_key_id === "number" &&
    Number.isFinite(value.api_key_id)
  ) {
    normalized.api_key_id = value.api_key_id;
  }
  const key_id = optionalString(value.key_id, 80);
  if (key_id) normalized.key_id = key_id;
  const reason = optionalString(value.reason, 512);
  if (reason) normalized.reason = reason;
  const code = optionalString(value.code, 120);
  if (code) normalized.code = code;
  const capability = optionalString(value.capability, 120);
  if (capability) normalized.capability = capability;
  const project_id = optionalString(value.project_id, 80);
  if (project_id) normalized.project_id = project_id;
  const rpc = optionalString(value.rpc, 256);
  if (rpc) normalized.rpc = rpc;
  const subject = optionalString(value.subject, 512);
  if (subject) normalized.subject = subject;
  if (value.conat_operation === "sub" || value.conat_operation === "pub") {
    normalized.conat_operation = value.conat_operation;
  }
  return normalized;
}

export async function recordApiKeyAuditEvent({
  event,
  value,
}: {
  event: ApiKeyAuditEvent;
  value: ApiKeyAuditValue;
}): Promise<void> {
  try {
    await centralLog({
      event,
      value: normalizeApiKeyAuditValue(value),
    });
  } catch (err) {
    logger.warn("failed to write API key audit event", {
      event,
      err: `${err}`,
    });
  }
}

export function recordApiKeyAuditEventSoon({
  event,
  value,
}: {
  event: ApiKeyAuditEvent;
  value: ApiKeyAuditValue;
}): void {
  recordApiKeyAuditEvent({ event, value }).catch((err) => {
    logger.warn("failed to schedule API key audit event", {
      event,
      err: `${err}`,
    });
  });
}
