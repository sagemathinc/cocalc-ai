/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import centralLog from "@cocalc/database/postgres/central-log";
import {
  normalizeServiceAdmissionDenialEvent,
  setServiceAdmissionDenialRecorder,
  type ServiceAdmissionDenialEvent,
} from "@cocalc/conat/admission/denials";

function optionalString(value: unknown, maxLength: number): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export async function recordServiceAdmissionDenialLocal(
  event: ServiceAdmissionDenialEvent,
): Promise<void> {
  const normalized = normalizeServiceAdmissionDenialEvent(event);
  await centralLog({
    event: "service_admission_denied",
    value: {
      surface: optionalString(normalized.surface, 120) ?? "unknown",
      limit: optionalString(normalized.limit, 120) ?? "unknown",
      source: optionalString(normalized.source, 80) ?? "unknown",
      reason: optionalString(normalized.reason, 512),
      host_id: optionalString(normalized.host_id, 80),
      account_id: optionalString(normalized.account_id, 80),
      project_id: optionalString(normalized.project_id, 80),
      subject: optionalString(normalized.subject, 512),
      path: optionalString(normalized.path, 1024),
      key: optionalString(normalized.key, 256),
      current: normalized.current,
      maximum: normalized.maximum,
      time: new Date(normalized.time ?? Date.now()).toISOString(),
    },
  });
}

export function configureHubServiceAdmissionDenialRecorder(): void {
  setServiceAdmissionDenialRecorder(recordServiceAdmissionDenialLocal);
}
