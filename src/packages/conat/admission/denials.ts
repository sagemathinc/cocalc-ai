/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getLogger } from "@cocalc/conat/logger";
import { getServiceAdmissionNearLimitConfig } from "./limits";

const logger = getLogger("conat:admission:denials");

export interface ServiceAdmissionDenialEvent {
  surface: string;
  limit: string;
  current: number;
  maximum: number;
  source?: string;
  reason?: string;
  host_id?: string;
  account_id?: string;
  project_id?: string;
  subject?: string;
  path?: string;
  key?: string;
  time?: number;
}

type ServiceAdmissionDenialRecorder = (
  event: ServiceAdmissionDenialEvent,
) => void | Promise<void>;

let serviceAdmissionDenialRecorder: ServiceAdmissionDenialRecorder | undefined;
let serviceAdmissionNearLimitRecorder:
  | ServiceAdmissionDenialRecorder
  | undefined;
const nearLimitLastRecorded = new Map<string, number>();

export function setServiceAdmissionDenialRecorder(
  recorder?: ServiceAdmissionDenialRecorder,
): void {
  serviceAdmissionDenialRecorder = recorder;
}

export function setServiceAdmissionNearLimitRecorder(
  recorder?: ServiceAdmissionDenialRecorder,
): void {
  serviceAdmissionNearLimitRecorder = recorder;
}

function nonnegativeInteger(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

export function normalizeServiceAdmissionDenialEvent(
  event: ServiceAdmissionDenialEvent,
): ServiceAdmissionDenialEvent {
  return {
    ...event,
    surface: `${event.surface ?? ""}`.trim() || "unknown",
    limit: `${event.limit ?? ""}`.trim() || "unknown",
    current: nonnegativeInteger(event.current),
    maximum: nonnegativeInteger(event.maximum),
    source: `${event.source ?? ""}`.trim() || "unknown",
    time:
      typeof event.time === "number" && Number.isFinite(event.time)
        ? event.time
        : Date.now(),
  };
}

export function recordServiceAdmissionDenial(
  event: ServiceAdmissionDenialEvent,
): void {
  const recorder = serviceAdmissionDenialRecorder;
  if (recorder == null) {
    return;
  }
  const normalized = normalizeServiceAdmissionDenialEvent(event);
  void Promise.resolve()
    .then(() => recorder(normalized))
    .catch((err) => {
      logger.warn("failed to record service admission denial", {
        err: `${err}`,
        surface: normalized.surface,
        limit: normalized.limit,
        source: normalized.source,
      });
    });
}

function nearLimitThrottleKey(event: ServiceAdmissionDenialEvent): string {
  return [
    event.surface,
    event.limit,
    event.source,
    event.host_id,
    event.account_id,
    event.project_id,
    event.subject,
    event.path,
    event.key,
  ]
    .map((value) => `${value ?? ""}`)
    .join("\n");
}

export function recordServiceAdmissionNearLimit(
  event: ServiceAdmissionDenialEvent,
): void {
  const recorder = serviceAdmissionNearLimitRecorder;
  if (recorder == null) {
    return;
  }
  const normalized = normalizeServiceAdmissionDenialEvent(event);
  const { thresholdPercent, logIntervalMs } =
    getServiceAdmissionNearLimitConfig();
  if (
    normalized.maximum <= 0 ||
    normalized.current * 100 < normalized.maximum * thresholdPercent
  ) {
    return;
  }
  const key = nearLimitThrottleKey(normalized);
  const lastRecorded = nearLimitLastRecorded.get(key) ?? 0;
  if (normalized.time! - lastRecorded < logIntervalMs) {
    return;
  }
  nearLimitLastRecorded.set(key, normalized.time!);
  void Promise.resolve()
    .then(() => recorder(normalized))
    .catch((err) => {
      logger.warn("failed to record service admission near-limit event", {
        err: `${err}`,
        surface: normalized.surface,
        limit: normalized.limit,
        source: normalized.source,
      });
    });
}
