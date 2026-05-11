/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type EmailLane =
  | "critical"
  | "transactional"
  | "notification"
  | "marketing";

export type EmailBackend = "" | "none" | "sendgrid" | "smtp";
export type EmailLaneBackend = "default" | EmailBackend;

export const EMAIL_LANES: ReadonlyArray<{
  key: EmailLane;
  label: string;
  description: string;
}> = [
  {
    key: "critical",
    label: "Critical",
    description:
      "Security, account recovery, failed payment, and host enforcement email.",
  },
  {
    key: "transactional",
    label: "Transactional",
    description: "Receipts, support replies, and account/admin notices.",
  },
  {
    key: "notification",
    label: "Notification",
    description:
      "User-triggered notification email such as mentions, invites, and digests.",
  },
  {
    key: "marketing",
    label: "Marketing",
    description: "Optional product announcements and similar mail.",
  },
] as const;

export const EMAIL_BACKENDS: ReadonlyArray<EmailBackend> = [
  "",
  "none",
  "sendgrid",
  "smtp",
] as const;

export const EMAIL_LANE_BACKENDS: ReadonlyArray<EmailLaneBackend> = [
  "default",
  ...EMAIL_BACKENDS,
] as const;

export function notificationEmailBackendSettingName(lane: EmailLane): string {
  return `notification_email_${lane}_backend`;
}

export function normalizeEmailLane(value: unknown): EmailLane {
  const lane = `${value ?? ""}`.trim();
  if (EMAIL_LANES.some(({ key }) => key === lane)) {
    return lane as EmailLane;
  }
  throw Error(`invalid email lane '${value ?? ""}'`);
}

export function normalizeEmailBackend(value: unknown): EmailBackend {
  const backend = `${value ?? ""}`.trim();
  if (EMAIL_BACKENDS.includes(backend as EmailBackend)) {
    return backend as EmailBackend;
  }
  throw Error(`invalid email backend '${value ?? ""}'`);
}

export function normalizeEmailLaneBackend(value: unknown): EmailLaneBackend {
  const backend = `${value ?? ""}`.trim() || "default";
  if (EMAIL_LANE_BACKENDS.includes(backend as EmailLaneBackend)) {
    return backend as EmailLaneBackend;
  }
  throw Error(`invalid email lane backend '${value ?? ""}'`);
}

export function resolveEmailBackendForLane(
  settings: Record<string, any>,
  lane: EmailLane = "transactional",
): EmailBackend {
  const laneBackend = normalizeEmailLaneBackend(
    settings[notificationEmailBackendSettingName(lane)],
  );
  if (laneBackend !== "default") {
    return normalizeEmailBackend(laneBackend);
  }
  return normalizeEmailBackend(settings.email_backend);
}
