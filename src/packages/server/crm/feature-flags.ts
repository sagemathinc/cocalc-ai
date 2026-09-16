/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  CRM_FEATURE_FLAGS,
  type CrmCapability,
  type CrmFeatureFlagName,
  type CrmFeatureFlagSnapshot,
} from "@cocalc/util/crm";

export const CRM_FLAGS = CRM_FEATURE_FLAGS;
export type { CrmCapability };

const READ_ACTIONS = new Set([
  "listOrganizations",
  "searchOrganizations",
  "getSupportContext",
  "getOrganization",
  "getCustomerTimeline",
  "listExternalReferences",
  "listPeople",
  "searchPeople",
  "getPerson",
  "listOpportunities",
  "getOpportunity",
  "listTasks",
  "getTask",
  "getCustomerMetrics",
  "getDiagnostics",
  "getDailyDigest",
  "listOutreachTemplates",
  "getOutreachTemplate",
  "listOutreachBatches",
  "getOutreachBatch",
  "listOutreachDeliveries",
  "getOutreachDelivery",
  "listOutreachProviderOperations",
  "previewOutreachBatch",
  "listContactSuppressions",
  "getOutreachLimits",
  "getOutreachDiagnostics",
  "listOutreachEngagementEvents",
  "listOutreachFollowups",
  "previewOutreachFollowup",
]);

const OUTREACH_READ_ACTIONS = new Set([
  "listOutreachTemplates",
  "getOutreachTemplate",
  "listOutreachBatches",
  "getOutreachBatch",
  "listOutreachDeliveries",
  "getOutreachDelivery",
  "listOutreachProviderOperations",
  "previewOutreachBatch",
  "listContactSuppressions",
  "getOutreachLimits",
  "getOutreachDiagnostics",
  "listOutreachEngagementEvents",
  "listOutreachFollowups",
  "previewOutreachFollowup",
]);

export function crmActionCapabilities(
  action: string,
  request: Record<string, unknown> = {},
): CrmCapability[] {
  if (action === "exportData") return ["visible", "export"];
  if (action === "backfill") return ["visible", "backfill"];
  if (action === "getCustomerMetrics") return ["visible", "metrics"];
  if (OUTREACH_READ_ACTIONS.has(action)) {
    return ["visible", "outreach"];
  }
  if (READ_ACTIONS.has(action)) return ["visible"];
  if (
    [
      "createOutreachTemplate",
      "transitionOutreachTemplate",
      "createOutreachBatch",
      "updateOutreachBatch",
      "addOutreachRecipient",
      "updateOutreachRecipient",
      "removeOutreachRecipient",
      "transitionOutreachBatch",
      "mutateOutreachDelivery",
      "mutateContactSuppression",
    ].includes(action)
  ) {
    return ["visible", "mutate", "outreach", "outreachMutate"];
  }
  if (["sendOutreachFollowup", "syncOutreachDelivery"].includes(action)) {
    return [
      "visible",
      "mutate",
      "zendesk",
      "outreach",
      "outreachMutate",
      "outreachDelivery",
    ];
  }
  if (
    [
      "createOpportunity",
      "updateOpportunity",
      "transitionOpportunity",
      "createTask",
      "updateTask",
      "transitionTask",
    ].includes(action)
  ) {
    return ["visible", "mutate", "pipeline"];
  }
  if (
    action === "createCommercialOrderFromOpportunity" ||
    action === "linkOpportunityCommercialOrder" ||
    action === "unlinkOpportunityCommercialOrder"
  ) {
    return ["visible", "mutate", "pipeline", "commercial"];
  }
  if (action === "mutateExternalReference") {
    if (request.provider === "zendesk") {
      return ["visible", "mutate", "zendesk"];
    }
    if (
      request.provider === "stripe" ||
      ["commercial_order", "site_license"].includes(
        `${request.object_kind ?? ""}`,
      )
    ) {
      return ["visible", "mutate", "commercial"];
    }
    return ["visible", "mutate"];
  }
  return ["visible", "mutate"];
}

export async function assertCrmCapability(
  capability: CrmCapability,
): Promise<void> {
  const settings = await getServerSettings();
  if (settings[CRM_FLAGS[capability]] === true) return;
  throw Object.assign(
    Error(`CRM capability '${capability}' is disabled by site settings`),
    { code: 503 },
  );
}

export async function getCrmCapabilities(): Promise<
  Record<CrmCapability, boolean>
> {
  const snapshot = await getCrmFeatureFlagSnapshot();
  return Object.fromEntries(
    Object.entries(CRM_FLAGS).map(([capability, setting]) => [
      capability,
      snapshot[setting],
    ]),
  ) as Record<CrmCapability, boolean>;
}

export function crmFeatureFlagSnapshot(
  settings: Partial<Record<CrmFeatureFlagName, unknown>>,
): CrmFeatureFlagSnapshot {
  return Object.fromEntries(
    Object.values(CRM_FLAGS).map((setting) => [
      setting,
      settings[setting] === true,
    ]),
  ) as CrmFeatureFlagSnapshot;
}

export async function getCrmFeatureFlagSnapshot(): Promise<CrmFeatureFlagSnapshot> {
  return crmFeatureFlagSnapshot(await getServerSettings());
}
