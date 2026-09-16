/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import centralLog from "@cocalc/database/postgres/central-log";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { dispatchCrmSeedRequest } from "@cocalc/server/crm/dispatch";
import {
  assertCrmCapability,
  crmActionCapabilities,
} from "@cocalc/server/crm/feature-flags";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import type { AdminCrmApi } from "@cocalc/conat/hub/api/crm";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";

type Method = keyof AdminCrmApi;
type Input<K extends Method> = Parameters<AdminCrmApi[K]>[0];
type Output<K extends Method> = Awaited<ReturnType<AdminCrmApi[K]>>;

type Request = {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  reason?: string;
  source?: string;
  commit?: boolean;
};

async function requireAdmin(opts: Request, fresh: boolean): Promise<string> {
  const accountId = `${opts.account_id ?? ""}`.trim();
  if (!accountId) throw Error("must be signed in");
  if (!(await isAdmin(accountId))) {
    throw Object.assign(Error("admin privileges required"), { code: 403 });
  }
  const reason = `${opts.reason ?? ""}`.trim();
  if (reason.length < 4) {
    throw Error("a human-readable audit reason is required");
  }
  if (reason.length > 2_000) {
    throw Error("audit reason must be at most 2000 characters");
  }
  if (fresh) {
    await requireDangerousSessionAuth({
      account_id: accountId,
      browser_id: opts.browser_id,
      session_hash: opts.session_hash,
      require_second_factor: "if_enabled",
      allow_actor_impersonation: false,
    });
  }
  return accountId;
}

async function invoke<K extends Method>(
  action: K,
  opts: Input<K>,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<Output<K>> {
  const request = opts as Request;
  const source = request.source ?? "admin-ui";
  if (!["admin-ui", "cli", "migration"].includes(source)) {
    throw Error(
      "public CRM calls may only use admin-ui, cli, or migration as their source",
    );
  }
  const actorAccountId = await requireAdmin(request, fresh);
  for (const capability of crmActionCapabilities(
    action,
    opts as unknown as Record<string, unknown>,
  )) {
    await assertCrmCapability(capability);
  }
  const payload = { ...opts, source } as Record<string, unknown>;
  delete payload.account_id;
  delete payload.browser_id;
  delete payload.session_hash;
  const started = Date.now();
  let error: unknown;
  try {
    if (getConfiguredBayId() === getConfiguredClusterSeedBayId()) {
      return (await dispatchCrmSeedRequest({
        action,
        actor_account_id: actorAccountId,
        payload,
      })) as Output<K>;
    }
    return (await getInterBayBridge()
      .bayOps(getConfiguredClusterSeedBayId(), { timeout_ms: 120_000 })
      .crm({ action, actor_account_id: actorAccountId, payload })) as Output<K>;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    try {
      await centralLog({
        event: "crm_operator",
        value: {
          actor_account_id: actorAccountId,
          action,
          reason: request.reason,
          duration_ms: Date.now() - started,
          fresh_auth: fresh,
          committed: request.commit === true,
          ok: error == null,
          error: error == null ? null : `${error}`.slice(0, 500),
        },
      });
    } catch {
      // crm_mutation_events is authoritative for writes; central_log is best effort.
    }
  }
}

const read =
  <K extends Method>(action: K) =>
  async (opts: Input<K>): Promise<Output<K>> =>
    await invoke(action, opts);
const mutation =
  <K extends Method>(action: K) =>
  async (opts: Input<K>): Promise<Output<K>> =>
    await invoke(action, opts, { fresh: (opts as Request).commit === true });
const sensitive =
  <K extends Method>(action: K) =>
  async (opts: Input<K>): Promise<Output<K>> =>
    await invoke(action, opts, { fresh: true });

export const listOrganizations = read("listOrganizations");
export const searchOrganizations = read("searchOrganizations");
export const getSupportContext = read("getSupportContext");
export const getOrganization = read("getOrganization");
export const getCustomerTimeline = read("getCustomerTimeline");
export const listExternalReferences = read("listExternalReferences");
export const listPeople = read("listPeople");
export const searchPeople = read("searchPeople");
export const getPerson = read("getPerson");
export const listOpportunities = read("listOpportunities");
export const getOpportunity = read("getOpportunity");
export const listTasks = read("listTasks");
export const getTask = read("getTask");
export const getCustomerMetrics = async (
  opts: Input<"getCustomerMetrics">,
): Promise<Output<"getCustomerMetrics">> =>
  await invoke("getCustomerMetrics", opts, { fresh: opts.refresh === true });
export const getDiagnostics = read("getDiagnostics");
export const getDailyDigest = read("getDailyDigest");
export const exportData = sensitive("exportData");
export const createOrganization = mutation("createOrganization");
export const updateOrganization = mutation("updateOrganization");
export const archiveOrganization = mutation("archiveOrganization");
export const mergeOrganizations = mutation("mergeOrganizations");
export const mutateDomain = mutation("mutateDomain");
export const createPerson = mutation("createPerson");
export const updatePerson = mutation("updatePerson");
export const mutatePersonEmail = mutation("mutatePersonEmail");
export const mutatePersonAccount = mutation("mutatePersonAccount");
export const mutateOrganizationPerson = mutation("mutateOrganizationPerson");
export const createOpportunity = mutation("createOpportunity");
export const updateOpportunity = mutation("updateOpportunity");
export const transitionOpportunity = mutation("transitionOpportunity");
export const createTask = mutation("createTask");
export const updateTask = mutation("updateTask");
export const transitionTask = mutation("transitionTask");
export const addActivity = mutation("addActivity");
export const mutateExternalReference = mutation("mutateExternalReference");
export const createCommercialOrderFromOpportunity = mutation(
  "createCommercialOrderFromOpportunity",
);
export const linkOpportunityCommercialOrder = mutation(
  "linkOpportunityCommercialOrder",
);
export const unlinkOpportunityCommercialOrder = mutation(
  "unlinkOpportunityCommercialOrder",
);
export const backfill = mutation("backfill");
export const listOutreachTemplates = read("listOutreachTemplates");
export const getOutreachTemplate = read("getOutreachTemplate");
export const listOutreachBatches = read("listOutreachBatches");
export const getOutreachBatch = read("getOutreachBatch");
export const listOutreachDeliveries = read("listOutreachDeliveries");
export const getOutreachDelivery = read("getOutreachDelivery");
export const listOutreachProviderOperations = read(
  "listOutreachProviderOperations",
);
export const previewOutreachBatch = read("previewOutreachBatch");
export const listContactSuppressions = read("listContactSuppressions");
export const getOutreachLimits = read("getOutreachLimits");
export const getOutreachDiagnostics = read("getOutreachDiagnostics");
export const listOutreachEngagementEvents = read(
  "listOutreachEngagementEvents",
);
export const listOutreachFollowups = read("listOutreachFollowups");
export const previewOutreachFollowup = read("previewOutreachFollowup");
export const createOutreachTemplate = mutation("createOutreachTemplate");
export const transitionOutreachTemplate = mutation(
  "transitionOutreachTemplate",
);
export const createOutreachBatch = mutation("createOutreachBatch");
export const updateOutreachBatch = mutation("updateOutreachBatch");
export const addOutreachRecipient = mutation("addOutreachRecipient");
export const removeOutreachRecipient = mutation("removeOutreachRecipient");
export const transitionOutreachBatch = mutation("transitionOutreachBatch");
export const mutateOutreachDelivery = mutation("mutateOutreachDelivery");
export const mutateContactSuppression = mutation("mutateContactSuppression");
export const sendOutreachFollowup = mutation("sendOutreachFollowup");
export const syncOutreachDelivery = mutation("syncOutreachDelivery");
