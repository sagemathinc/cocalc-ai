/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const RUNTIME_SPONSOR_DENIAL_MARKER = "COCALC_RUNTIME_SPONSOR_DENIAL:";

export interface RuntimeSponsorDenialProject {
  project_id: string;
  title?: string;
  state?: "starting" | "running";
  visible?: boolean;
  can_stop?: boolean;
}

export interface RuntimeSponsorDenial {
  code: "runtime_sponsor_slots_exhausted";
  sponsor_account_id: string;
  sponsor_display_name?: string;
  limit: number;
  current: number;
  active_projects: RuntimeSponsorDenialProject[];
  can_change_sponsor?: boolean;
  can_upgrade?: boolean;
}

function isRuntimeSponsorDenial(value: any): value is RuntimeSponsorDenial {
  return (
    value != null &&
    value.code === "runtime_sponsor_slots_exhausted" &&
    typeof value.sponsor_account_id === "string" &&
    typeof value.limit === "number" &&
    typeof value.current === "number" &&
    Array.isArray(value.active_projects)
  );
}

export function encodeRuntimeSponsorDenial(
  denial: RuntimeSponsorDenial,
): string {
  return `${RUNTIME_SPONSOR_DENIAL_MARKER}${JSON.stringify(denial)}`;
}

export function extractRuntimeSponsorDenial(
  value: unknown,
): RuntimeSponsorDenial | undefined {
  const text =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? `${value}`
        : `${value ?? ""}`;
  const markerIndex = text.indexOf(RUNTIME_SPONSOR_DENIAL_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }
  const jsonText = text.slice(
    markerIndex + RUNTIME_SPONSOR_DENIAL_MARKER.length,
  );
  try {
    const parsed = JSON.parse(jsonText);
    if (isRuntimeSponsorDenial(parsed)) {
      return parsed;
    }
  } catch {
    // ignore malformed denial payloads and fall back to generic errors
  }
  return undefined;
}

export function formatRuntimeSponsorDenial(
  denial: RuntimeSponsorDenial,
): string {
  const sponsor =
    `${denial.sponsor_display_name ?? ""}`.trim() ||
    "this project's runtime sponsor";
  const actions: string[] = [];
  if (
    denial.active_projects.some(
      (project) => project.visible !== false && project.can_stop !== false,
    )
  ) {
    actions.push("stop another project that runs on this membership");
  }
  if (denial.can_upgrade) {
    actions.push("increase the sponsor membership limit");
  } else {
    actions.push("ask the sponsor to increase the limit");
  }
  if (denial.can_change_sponsor) {
    actions.push("change this project's runtime sponsor");
  }
  return `${sponsor} is using ${denial.current}/${denial.limit} sponsored running-project slots. ${capitalizeFirst(joinActions(actions))}.`;
}

function joinActions(actions: string[]): string {
  if (actions.length === 0) {
    return "try again after a sponsored project stops";
  }
  if (actions.length === 1) {
    return actions[0];
  }
  if (actions.length === 2) {
    return `${actions[0]} or ${actions[1]}`;
  }
  return `${actions.slice(0, -1).join(", ")}, or ${actions[actions.length - 1]}`;
}

function capitalizeFirst(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
