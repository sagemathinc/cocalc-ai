/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getLogger } from "@cocalc/conat/logger";

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

export function setServiceAdmissionDenialRecorder(
  recorder?: ServiceAdmissionDenialRecorder,
): void {
  serviceAdmissionDenialRecorder = recorder;
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
