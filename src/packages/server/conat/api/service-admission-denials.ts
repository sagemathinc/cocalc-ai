/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import centralLog from "@cocalc/database/postgres/central-log";
import getLogger from "@cocalc/backend/logger";
import { createHubAdmissionDenialRecorder } from "./hub-admission-denials";
import {
  normalizeServiceAdmissionDenialEvent,
  setServiceAdmissionDenialRecorder,
  setServiceAdmissionNearLimitRecorder,
  type ServiceAdmissionDenialEvent,
} from "@cocalc/conat/admission/denials";

const logger = getLogger("server:conat:api:admission-denials");
export const hubAdmissionDenials = createHubAdmissionDenialRecorder({
  record: recordServiceAdmissionDenialLocal,
  warn: (message, details) => logger.warn(message, details),
});

function optionalString(value: unknown, maxLength: number): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export async function recordServiceAdmissionDenialLocal(
  event: ServiceAdmissionDenialEvent,
): Promise<void> {
  await recordServiceAdmissionEventLocal("service_admission_denied", event);
}

export async function recordServiceAdmissionNearLimitLocal(
  event: ServiceAdmissionDenialEvent,
): Promise<void> {
  await recordServiceAdmissionEventLocal("service_admission_near_limit", event);
}

async function recordServiceAdmissionEventLocal(
  centralLogEvent: "service_admission_denied" | "service_admission_near_limit",
  event: ServiceAdmissionDenialEvent,
): Promise<void> {
  const normalized = normalizeServiceAdmissionDenialEvent(event);
  await centralLog({
    event: centralLogEvent,
    value: {
      surface: optionalString(normalized.surface, 120) ?? "unknown",
      limit: optionalString(normalized.limit, 120) ?? "unknown",
      source: optionalString(normalized.source, 80) ?? "unknown",
      reason: optionalString(normalized.reason, 512),
      host_id: optionalString(normalized.host_id, 80),
      account_id: optionalString(normalized.account_id, 80),
      project_id: optionalString(normalized.project_id, 80),
      browser_id: optionalString(normalized.browser_id, 80),
      socket_id: optionalString(normalized.socket_id, 120),
      subject: optionalString(normalized.subject, 512),
      path: optionalString(normalized.path, 1024),
      key: optionalString(normalized.key, 256),
      current: normalized.current,
      maximum: normalized.maximum,
      count: normalized.count ?? 1,
      suppressed_count: normalized.suppressed_count ?? 0,
      first_time: new Date(
        normalized.first_time ?? normalized.time ?? Date.now(),
      ).toISOString(),
      last_time: new Date(
        normalized.last_time ?? normalized.time ?? Date.now(),
      ).toISOString(),
      time: new Date(normalized.time ?? Date.now()).toISOString(),
    },
  });
}

export function configureHubServiceAdmissionDenialRecorder(): void {
  setServiceAdmissionDenialRecorder(recordServiceAdmissionDenialLocal);
  setServiceAdmissionNearLimitRecorder(recordServiceAdmissionNearLimitLocal);
}
