/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { CrmOrganizationListRequest } from "@cocalc/conat/hub/api/crm";
import { CRM_OPPORTUNITY_KINDS } from "@cocalc/util/crm";

export type CustomerView =
  | "active"
  | "prospects"
  | "pipeline"
  | "pilots"
  | "customers"
  | "renewals"
  | "expansions"
  | "overdue"
  | "unassigned"
  | "all";

export const VIEW_OPTIONS: Array<{ label: string; value: CustomerView }> = [
  { label: "Active relationships", value: "active" },
  { label: "Prospects", value: "prospects" },
  { label: "Open opportunities", value: "pipeline" },
  { label: "Adoption pilots", value: "pilots" },
  { label: "Customers", value: "customers" },
  { label: "Renewal opportunities", value: "renewals" },
  { label: "Expansion opportunities", value: "expansions" },
  { label: "Overdue follow-up", value: "overdue" },
  { label: "Unassigned", value: "unassigned" },
  { label: "All records", value: "all" },
];

export function viewRequest(
  view: CustomerView,
): Partial<CrmOrganizationListRequest> {
  switch (view) {
    case "prospects":
      return { lifecycle_stages: ["prospect"] };
    case "pipeline":
      return { opportunity_kinds: [...CRM_OPPORTUNITY_KINDS] };
    case "pilots":
      return {
        opportunity_kinds: ["adoption_pilot", "new_site_license"],
        include_won_active_site_license_offers: true,
      };
    case "customers":
      return { lifecycle_stages: ["customer"] };
    case "renewals":
      return { opportunity_kinds: ["renewal"] };
    case "expansions":
      return { opportunity_kinds: ["expansion"] };
    case "overdue":
      return { has_overdue_tasks: true };
    case "unassigned":
      return { unassigned: true };
    case "all":
      return {};
    default:
      return { statuses: ["active"] };
  }
}

export function queueFilterRequest(
  view: CustomerView,
  ownerAccountId?: string,
): Partial<CrmOrganizationListRequest> {
  return {
    ...viewRequest(view),
    ...(view !== "unassigned" && ownerAccountId
      ? { owner_account_id: ownerAccountId }
      : {}),
  };
}

export function viewDescription(view: CustomerView): string {
  switch (view) {
    case "prospects":
      return "Organizations whose customer lifecycle is Prospect.";
    case "pipeline":
      return "Organizations with at least one open commercial opportunity.";
    case "pilots":
      return "Organizations with an open Adoption pilot or Site license opportunity, plus accepted Site license offers backed by a current license.";
    case "customers":
      return "Organizations whose customer lifecycle is Customer.";
    case "renewals":
      return "Organizations with an open Renewal opportunity.";
    case "expansions":
      return "Organizations with an open Expansion opportunity.";
    case "overdue":
      return "Organizations whose next open task is overdue.";
    case "unassigned":
      return "Organizations without a relationship owner.";
    case "all":
      return "Every active, archived, or merged CRM organization.";
    default:
      return "Every active CRM organization, across all lifecycle stages.";
  }
}

export function emptyViewDescription(
  view: CustomerView,
  hasSearch: boolean,
): string {
  if (hasSearch) {
    return "No search results match this view.";
  }
  switch (view) {
    case "pipeline":
      return "There are no open commercial opportunities.";
    case "pilots":
      return "There are no Adoption pilot or current Site license offers.";
    case "renewals":
      return "There are no open Renewal opportunities.";
    case "expansions":
      return "There are no open Expansion opportunities.";
    case "overdue":
      return "There are no customers with overdue follow-up.";
    case "unassigned":
      return "Every active customer has a relationship owner.";
    default:
      return "No customers match this view.";
  }
}
