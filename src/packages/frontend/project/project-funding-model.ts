/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// What the project funding banner shows and sends (pure, for tests).

import type {
  ProjectFundingState,
  ProjectFundingTerms,
} from "@cocalc/util/gpu/project-funding";

export interface FundingForm {
  amount: number;
  days: number;
  agents_allowed: boolean;
  max_hourly_usd?: number;
  max_concurrent_pods?: number;
  max_runtime_hours?: number;
  // set when the dialog also raises the key budget
  raise_key_budget_to?: string;
}

export const defaultTerms: FundingForm = {
  amount: 50,
  days: 7,
  agents_allowed: true,
};

const cents = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

export function fundingTerms(form: FundingForm): ProjectFundingTerms {
  const terms: ProjectFundingTerms = {
    provider: "runpod",
    authorized_usd: cents(form.amount),
    days: Math.round(form.days),
    agents_allowed: form.agents_allowed,
  };
  if (form.max_hourly_usd != null) {
    terms.max_hourly_usd = cents(form.max_hourly_usd);
  }
  if (form.max_concurrent_pods != null) {
    terms.max_concurrent_pods = Math.round(form.max_concurrent_pods);
  }
  if (form.max_runtime_hours != null) {
    terms.max_runtime_minutes = Math.round(form.max_runtime_hours * 60);
  }
  return terms;
}

const usd = (v: string | number | undefined) =>
  v == null ? "?" : `$${Number(v).toFixed(2)}`;

export function requestLine(
  request: NonNullable<ProjectFundingState["request"]>,
): string {
  const s: any = request.summary ?? {};
  const what = [
    s.gpu_count && s.gpu_count > 1 ? `${s.gpu_count}×` : "",
    s.gpu_type_id ?? "a GPU",
  ].join("");
  const hours =
    typeof s.max_runtime_minutes === "number"
      ? ` for up to ${Math.round((s.max_runtime_minutes / 60) * 10) / 10} h`
      : "";
  const who =
    request.actor_kind === "project"
      ? "from a terminal or code in this project"
      : request.actor_kind === "agent"
        ? "by an agent"
        : "by a collaborator";
  return `${what}${hours}, ${who}`;
}

export function approvalLine(
  approval: NonNullable<ProjectFundingState["approval"]>,
  isFunder: boolean,
): string {
  const d = approval.display;
  const who = isFunder
    ? "your RunPod account"
    : `${d?.funder_name ?? "a collaborator"}'s RunPod account`;
  if (approval.state === "pending") {
    return `GPU use in this project is being approved, paid by ${who}.`;
  }
  const until = d?.ends_at
    ? ` until ${new Date(d.ends_at).toLocaleDateString()}`
    : "";
  const left = approval.spend
    ? `${usd(approval.spend.available_usd)} of ${usd(approval.spend.authorized_usd)} left`
    : `up to ${usd(d?.authorized_usd)}`;
  const agents = d?.agents_allowed === false ? " (not agents)" : "";
  return `GPUs in this project are paid by ${who}: ${left}${until}${agents}.`;
}

// The key budget's new total when an approval needs more than what's left
// (a raise sets the total): what's authorized now plus the shortfall.
export function keyRaiseTarget(
  key: { available: number; authorized: number } | undefined,
  amount: number,
): string | undefined {
  if (key == null || !(amount > key.available)) return undefined;
  const shortfall = amount - Math.max(key.available, 0);
  return (Math.ceil((key.authorized + shortfall) * 100) / 100).toFixed(2);
}
