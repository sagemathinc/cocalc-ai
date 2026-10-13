/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  CommercialFulfillmentPlan,
  CommercialFulfillmentPreviewRequest,
  CommercialOrderTransitionRequest,
  CommercialProvisionRequest,
} from "@cocalc/conat/hub/api/commercial-orders";
import { isDeepStrictEqual } from "node:util";
import type {
  SiteLicenseOverview,
  SiteLicensePoolConfig,
} from "@cocalc/conat/hub/api/purchases";
import getPool from "@cocalc/database/pool";
import {
  addSiteLicensePool,
  adminProvisionSiteLicense,
  archiveSiteLicensePool,
  getSiteLicenseOverview,
  removeSiteLicenseManager,
  setSiteLicenseManager,
  updateSiteLicense,
  updateSiteLicensePool,
} from "@cocalc/server/membership/site-licenses";
import type {
  CommercialOrder,
  CommercialSiteLicensePlan,
} from "@cocalc/util/commercial-orders";
import {
  commercialIdempotencyKey,
  getCommercialOrder,
  getCommercialProviderOperationByIdempotencyKey,
  reserveCommercialProviderOperation,
  setCommercialFulfillment,
  setCommercialProviderOperationStatus,
} from "../store";
import { recordCommercialProviderFailure } from "../observability";
import { collectionSatisfied, requireReason } from "../state";

function string(value: unknown, name: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) throw Error(`${name} is required`);
  return normalized;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw Error(`${name} must be an array`);
  return [...new Set(value.map((entry) => string(entry, name).toLowerCase()))];
}

function siteLicensePlan(
  order: CommercialOrder,
): CommercialSiteLicensePlan | undefined {
  const raw = order.terms_snapshot.site_license;
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw Error("terms_snapshot.site_license must be an object");
  }
  const value = raw as Record<string, any>;
  if (!Array.isArray(value.pools) || value.pools.length === 0) {
    throw Error("site-license plan needs at least one pool");
  }
  const pools = value.pools.map((pool: any, index: number) => ({
    membership_class: string(
      pool.membership_class,
      `pool ${index + 1} membership_class`,
    ),
    seat_limit: Math.floor(Number(pool.seat_limit)),
    label: `${pool.label ?? pool.membership_class}`.trim(),
  }));
  if (
    new Set(pools.map(({ membership_class }) => membership_class)).size !==
    pools.length
  ) {
    throw Error(
      "site-license plan cannot contain duplicate membership classes",
    );
  }
  return {
    name: string(value.name, "site-license name"),
    organization_name: string(
      value.organization_name ?? order.organization_name,
      "site-license organization_name",
    ),
    owner_account_id: string(
      value.owner_account_id,
      "site-license owner_account_id",
    ),
    manager_account_ids: stringArray(
      value.manager_account_ids ?? [],
      "manager_account_ids",
    ),
    allowed_domains: stringArray(
      value.allowed_domains ?? [],
      "allowed_domains",
    ),
    pools,
    starts_at: new Date(
      string(value.starts_at, "site-license starts_at"),
    ).toISOString(),
    expires_at: new Date(
      string(value.expires_at, "site-license expires_at"),
    ).toISOString(),
    custom_terms_url: value.custom_terms_url,
    custom_policy_url: value.custom_policy_url,
    terms_version_label: value.terms_version_label,
    renewal_policy: value.renewal_policy,
    overage_policy: value.overage_policy,
    metadata: value.metadata ?? {},
  };
}

function poolConfig(
  plan: CommercialSiteLicensePlan,
  pool: CommercialSiteLicensePlan["pools"][number],
): SiteLicensePoolConfig {
  if (!Number.isInteger(pool.seat_limit) || pool.seat_limit < 1) {
    throw Error(
      `pool ${pool.membership_class} needs a positive integer seat_limit`,
    );
  }
  return {
    pool_name: pool.label ?? pool.membership_class,
    membership_class: pool.membership_class as any,
    seat_count: pool.seat_limit,
    requires_approval: false,
    verification_policy: "email-domain",
    allowed_domains: plan.allowed_domains,
    metadata: { commercial_fulfillment: true },
  };
}

function sameStrings(left: string[], right: string[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function dateValue(value: Date | string | null | undefined): number {
  return value == null ? 0 : new Date(value).getTime();
}

function optionalString(value: unknown): string {
  return value == null ? "" : `${value}`;
}

function fulfillmentMismatches(
  plan: CommercialSiteLicensePlan,
  overview: SiteLicenseOverview,
): string[] {
  const mismatches: string[] = [];
  const license = overview.site_license;
  if (license.name !== plan.name) mismatches.push("name");
  if (license.organization_name !== plan.organization_name)
    mismatches.push("organization_name");
  if (license.owner_account_id !== plan.owner_account_id)
    mismatches.push("owner_account_id");
  if (!sameStrings(license.allowed_domains ?? [], plan.allowed_domains)) {
    mismatches.push("allowed_domains");
  }
  if (dateValue(license.starts_at) !== dateValue(plan.starts_at))
    mismatches.push("starts_at");
  if (dateValue(license.expires_at) !== dateValue(plan.expires_at))
    mismatches.push("expires_at");
  for (const field of [
    "custom_terms_url",
    "custom_policy_url",
    "terms_version_label",
    "renewal_policy",
    "overage_policy",
  ] as const) {
    if (optionalString(license[field]) !== optionalString(plan[field])) {
      mismatches.push(field);
    }
  }
  for (const [key, value] of Object.entries(plan.metadata ?? {})) {
    if (!isDeepStrictEqual(license.metadata?.[key], value)) {
      mismatches.push(`metadata:${key}`);
    }
  }
  const expectedPools = new Map(
    plan.pools.map((pool) => [pool.membership_class, pool]),
  );
  const seenPools = new Set<string>();
  for (const pool of overview.pools) {
    const expected = expectedPools.get(pool.membership_class);
    if (seenPools.has(pool.membership_class)) {
      mismatches.push(`duplicate-pool:${pool.membership_class}`);
      continue;
    }
    seenPools.add(pool.membership_class);
    if (
      !expected ||
      pool.seat_count !== expected.seat_limit ||
      pool.pool_name !== (expected.label ?? expected.membership_class) ||
      pool.requires_approval !== false ||
      pool.verification_policy !== "email-domain" ||
      !sameStrings(
        ((pool.metadata?.allowed_domains as string[] | undefined) ?? []).map(
          (domain) => domain.toLowerCase(),
        ),
        plan.allowed_domains,
      ) ||
      dateValue(pool.expires_at) !== dateValue(plan.expires_at)
    ) {
      mismatches.push(`pool:${pool.membership_class}`);
    }
    expectedPools.delete(pool.membership_class);
  }
  for (const membershipClass of expectedPools.keys()) {
    mismatches.push(`missing-pool:${membershipClass}`);
  }
  const expectedManagers = new Set(
    (plan.manager_account_ids ?? []).filter(
      (accountId) => accountId !== plan.owner_account_id,
    ),
  );
  const activeManagers = new Map(
    overview.managers
      .filter(({ revoked_at }) => !revoked_at)
      .map(({ account_id, role }) => [account_id, role]),
  );
  for (const manager of expectedManagers) {
    if (activeManagers.get(manager) !== "manager") {
      mismatches.push(`manager:${manager}`);
    }
  }
  for (const manager of activeManagers.keys()) {
    if (!expectedManagers.has(manager)) {
      mismatches.push(`extra-manager:${manager}`);
    }
  }
  return mismatches;
}

function assertProvisionableOrder(order: CommercialOrder): void {
  if (!order.approved_at || !order.approved_by_account_id) {
    throw Error("the commercial order must be approved before fulfillment");
  }
  if (["complete", "cancelled"].includes(order.workflow_state)) {
    throw Error(
      `a ${order.workflow_state} commercial order cannot be provisioned`,
    );
  }
}

async function assertExclusiveCommercialAssociation(opts: {
  orderId: string;
  siteLicenseId: string;
  current: SiteLicenseOverview;
}): Promise<void> {
  const metadataOrderId = `${
    opts.current.site_license.metadata?.commercial_order_id ?? ""
  }`.trim();
  if (metadataOrderId && metadataOrderId !== opts.orderId) {
    throw Error(
      `site license ${opts.siteLicenseId} belongs to commercial order ${metadataOrderId}`,
    );
  }
  const { rows } = await getPool().query<{ id: string; order_number: string }>(
    `SELECT id,order_number FROM commercial_orders
      WHERE site_license_id=$1 AND id<>$2 AND workflow_state<>'cancelled'
      ORDER BY created_at LIMIT 2`,
    [opts.siteLicenseId, opts.orderId],
  );
  if (rows.length) {
    throw Error(
      `site license ${opts.siteLicenseId} is already associated with commercial order ${rows[0].order_number ?? rows[0].id}`,
    );
  }
}

async function preflightExistingSiteLicense(opts: {
  actorAccountId: string;
  order: CommercialOrder;
  siteLicenseId: string;
  plan?: CommercialSiteLicensePlan;
}): Promise<SiteLicenseOverview> {
  const current = await overview(opts.actorAccountId, opts.siteLicenseId);
  if (
    opts.plan &&
    current.site_license.owner_account_id !== opts.plan.owner_account_id
  ) {
    throw Error(
      `site license owner does not match the approved commercial order`,
    );
  }
  await assertExclusiveCommercialAssociation({
    orderId: opts.order.id,
    siteLicenseId: opts.siteLicenseId,
    current,
  });
  if (opts.plan) {
    const expectedClasses = new Set(
      opts.plan.pools.map(({ membership_class }) => membership_class),
    );
    for (const pool of current.pools) {
      if (
        !expectedClasses.has(pool.membership_class) &&
        pool.active_assignment_count > 0
      ) {
        throw Error(
          `extra pool ${pool.membership_class} has active seats and cannot be archived`,
        );
      }
    }
  }
  return current;
}

function normalizedSiteLicenseId(value: unknown): string | undefined {
  return `${value ?? ""}`.trim() || undefined;
}

// The license to fulfill with: the one stored on the order, or, when none is
// stored yet, an existing license the operator names explicitly. Naming a
// different license than the stored one is rejected.
function targetSiteLicenseId(
  order: CommercialOrder,
  existingSiteLicenseId?: string,
): string | undefined {
  const requested = normalizedSiteLicenseId(existingSiteLicenseId);
  if (
    requested &&
    order.site_license_id &&
    requested !== order.site_license_id
  ) {
    throw Error(
      "existing_site_license_id must match the target already stored and reviewed on the commercial order",
    );
  }
  return order.site_license_id ?? requested;
}

function normalizedOrganization(value: unknown): string {
  return `${value ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Without a site-license plan nothing else ties a named license to the order,
// so it must agree with the order's frozen customer facts: CRM organization,
// organization name, customer account (owner or active manager), and a term
// covering the order's service period.
function namedTargetMismatches(
  order: CommercialOrder,
  current: SiteLicenseOverview,
): string[] {
  const license = current.site_license;
  const mismatches: string[] = [];
  if (
    order.crm_organization_id &&
    license.crm_organization_id &&
    order.crm_organization_id !== license.crm_organization_id
  ) {
    mismatches.push("crm_organization_id");
  }
  if (
    normalizedOrganization(license.organization_name) !==
    normalizedOrganization(order.organization_name)
  ) {
    mismatches.push("organization_name");
  }
  if (order.customer_account_id) {
    const managers = new Set(
      current.managers
        .filter(({ revoked_at }) => !revoked_at)
        .map(({ account_id }) => account_id),
    );
    if (
      license.owner_account_id !== order.customer_account_id &&
      !managers.has(order.customer_account_id)
    ) {
      mismatches.push("customer_account");
    }
  }
  if (
    order.service_starts_at &&
    license.starts_at != null &&
    dateValue(license.starts_at) > dateValue(order.service_starts_at)
  ) {
    mismatches.push("starts_at");
  }
  if (
    order.service_ends_at &&
    license.expires_at != null &&
    dateValue(license.expires_at) < dateValue(order.service_ends_at)
  ) {
    mismatches.push("expires_at");
  }
  return mismatches;
}

function namedTargetMismatchError(mismatches: string[]): string {
  return `site license does not match the commercial order (${mismatches.join(", ")}); review the target and pass allow_target_mismatch to link it anyway`;
}

function fulfillmentTarget(
  current: SiteLicenseOverview,
): NonNullable<CommercialFulfillmentPlan["target"]> {
  const license = current.site_license;
  return {
    name: license.name,
    organization_name: license.organization_name,
    crm_organization_id: license.crm_organization_id ?? null,
    owner_account_id: license.owner_account_id ?? null,
    starts_at: license.starts_at
      ? new Date(license.starts_at).toISOString()
      : null,
    expires_at: license.expires_at
      ? new Date(license.expires_at).toISOString()
      : null,
  };
}

async function overview(
  actorAccountId: string,
  siteLicenseId: string,
): Promise<SiteLicenseOverview> {
  return await getSiteLicenseOverview({
    account_id: actorAccountId,
    site_license_id: siteLicenseId,
  });
}

export async function commercialFulfillmentPreview(
  opts: CommercialFulfillmentPreviewRequest,
): Promise<CommercialFulfillmentPlan> {
  requireReason(opts.reason);
  if (!opts.account_id) throw Error("account_id is required");
  const order = await getCommercialOrder(opts.id);
  const blockers: string[] = [];
  const plannedChanges: string[] = [];
  try {
    assertProvisionableOrder(order);
  } catch (err) {
    blockers.push(`${err}`.replace(/^Error:\s*/, ""));
  }
  let plan: CommercialSiteLicensePlan | undefined;
  try {
    plan = siteLicensePlan(order);
  } catch (err) {
    blockers.push(`${err}`.replace(/^Error:\s*/, ""));
  }
  let siteLicenseId: string | null | undefined = order.site_license_id;
  try {
    siteLicenseId = targetSiteLicenseId(order, opts.existing_site_license_id);
  } catch (err) {
    blockers.push(`${err}`.replace(/^Error:\s*/, ""));
  }
  if (siteLicenseId && !order.site_license_id) {
    plannedChanges.push("order-site-license-link");
  }
  let action: CommercialFulfillmentPlan["action"] = siteLicenseId
    ? "link"
    : plan
      ? "create"
      : "none";
  if (!siteLicenseId && !plan) {
    blockers.push(
      "terms_snapshot.site_license is required to create a license",
    );
  }
  let target: CommercialFulfillmentPlan["target"];
  let targetMismatches: string[] | undefined;
  if (siteLicenseId) {
    try {
      const current = await preflightExistingSiteLicense({
        actorAccountId: opts.account_id,
        order,
        siteLicenseId,
        plan,
      });
      target = fulfillmentTarget(current);
      if (!plan && !order.site_license_id) {
        targetMismatches = namedTargetMismatches(order, current);
        if (targetMismatches.length && !opts.allow_target_mismatch) {
          blockers.push(namedTargetMismatchError(targetMismatches));
        }
      }
      if (!current.site_license.metadata?.commercial_order_id) {
        plannedChanges.push("commercial-order-association");
        action = "update";
      }
      if (plan) {
        const mismatches = fulfillmentMismatches(plan, current);
        if (mismatches.length) {
          plannedChanges.push(...mismatches);
          action = "update";
        }
      }
    } catch (err) {
      blockers.push(`${err}`.replace(/^Error:\s*/, ""));
    }
  }
  return {
    order_id: order.id,
    adapter: "site_license",
    action,
    site_license_id: siteLicenseId,
    ...(target ? { target } : {}),
    ...(targetMismatches ? { target_mismatches: targetMismatches } : {}),
    plan,
    planned_changes: plannedChanges,
    ready: blockers.length === 0,
    blockers,
  };
}

async function findRecoveredSiteLicense(
  orderId: string,
): Promise<string | undefined> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM site_licenses
      WHERE metadata->>'commercial_order_id'=$1 ORDER BY created LIMIT 2`,
    [orderId],
  );
  if (rows.length > 1)
    throw Error("multiple site licenses reference this commercial order");
  return rows[0]?.id;
}

async function applyPlanToExisting(opts: {
  actorAccountId: string;
  siteLicenseId: string;
  orderId: string;
  orderNumber: string;
  plan: CommercialSiteLicensePlan;
  current: SiteLicenseOverview;
}): Promise<SiteLicenseOverview> {
  let current = opts.current;
  await updateSiteLicense({
    actor_account_id: opts.actorAccountId,
    site_license_id: opts.siteLicenseId,
    name: opts.plan.name,
    organization_name: opts.plan.organization_name,
    allowed_domains: opts.plan.allowed_domains,
    custom_terms_url: opts.plan.custom_terms_url,
    custom_policy_url: opts.plan.custom_policy_url,
    terms_version_label: opts.plan.terms_version_label,
    metadata: {
      ...(opts.plan.metadata ?? {}),
      commercial_order_id: opts.orderId,
      commercial_order_number: opts.orderNumber,
    },
    renewal_policy: opts.plan.renewal_policy,
    overage_policy: opts.plan.overage_policy,
    starts_at: opts.plan.starts_at,
    expires_at: opts.plan.expires_at,
  });
  const expected = new Map(
    opts.plan.pools.map((pool) => [pool.membership_class, pool]),
  );
  for (const pool of current.pools) {
    const planned = expected.get(pool.membership_class);
    if (!planned) {
      await archiveSiteLicensePool({
        actor_account_id: opts.actorAccountId,
        package_id: pool.id,
      });
      continue;
    }
    await updateSiteLicensePool({
      actor_account_id: opts.actorAccountId,
      package_id: pool.id,
      pool_name: planned.label ?? planned.membership_class,
      seat_count: planned.seat_limit,
      expires_at: opts.plan.expires_at,
      allowed_domains: opts.plan.allowed_domains,
      requires_approval: false,
      verification_policy: "email-domain",
    });
    expected.delete(pool.membership_class);
  }
  for (const pool of expected.values()) {
    await addSiteLicensePool({
      actor_account_id: opts.actorAccountId,
      site_license_id: opts.siteLicenseId,
      pool: poolConfig(opts.plan, pool),
    });
  }
  for (const manager of opts.plan.manager_account_ids ?? []) {
    if (manager === opts.plan.owner_account_id) continue;
    await setSiteLicenseManager({
      actor_account_id: opts.actorAccountId,
      site_license_id: opts.siteLicenseId,
      target_account_id: manager,
      role: "manager",
    });
  }
  const expectedManagers = new Set(
    (opts.plan.manager_account_ids ?? []).filter(
      (accountId) => accountId !== opts.plan.owner_account_id,
    ),
  );
  for (const manager of current.managers) {
    if (!manager.revoked_at && !expectedManagers.has(manager.account_id)) {
      await removeSiteLicenseManager({
        actor_account_id: opts.actorAccountId,
        site_license_id: opts.siteLicenseId,
        target_account_id: manager.account_id,
      });
    }
  }
  current = await overview(opts.actorAccountId, opts.siteLicenseId);
  return current;
}

export async function provisionCommercialSiteLicense(
  opts: CommercialProvisionRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  const order = await getCommercialOrder(opts.id);
  // Canonicalize the named target so that the idempotency key and the stored
  // operation request identify the same license regardless of formatting.
  const namedTarget = normalizedSiteLicenseId(opts.existing_site_license_id);
  const key = commercialIdempotencyKey("site-license-provision", {
    ...opts,
    existing_site_license_id: namedTarget,
  } as any);
  const operationRequest = {
    existing_site_license_id: namedTarget ?? null,
    allow_before_payment: opts.allow_before_payment === true,
    ...(opts.allow_target_mismatch ? { allow_target_mismatch: true } : {}),
  };
  if (
    order.workflow_state === "complete" &&
    order.fulfillment_state === "provisioned" &&
    order.site_license_id
  ) {
    const prior = await getCommercialProviderOperationByIdempotencyKey(key);
    if (!prior) {
      throw Error("a complete commercial order cannot be provisioned");
    }
    // A replayed operation may only be resolved against the license it named.
    const priorTarget = normalizedSiteLicenseId(
      prior.request?.existing_site_license_id,
    );
    if (priorTarget && priorTarget !== order.site_license_id) {
      throw Error(
        `provision operation targeted site license ${priorTarget}, but the order is fulfilled with ${order.site_license_id}`,
      );
    }
    const reservation = await reserveCommercialProviderOperation({
      order_id: order.id,
      operation: "provision-site-license",
      expected_version: opts.expected_version,
      idempotency_key: key,
      request: operationRequest,
      exclusive: true,
    });
    if (reservation.operation.status === "succeeded") return order;
    const plan = siteLicensePlan(order);
    const current = await preflightExistingSiteLicense({
      actorAccountId: opts.account_id,
      order,
      siteLicenseId: order.site_license_id,
      plan,
    });
    const mismatches = plan ? fulfillmentMismatches(plan, current) : [];
    if (mismatches.length) {
      throw Error(
        `provisioned site license does not match the order: ${mismatches.join(", ")}`,
      );
    }
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { site_license_id: order.site_license_id, recovered: true },
    });
    return order;
  }
  assertProvisionableOrder(order);
  if (!collectionSatisfied(order) && !opts.allow_before_payment) {
    throw Error(
      "payment is not complete; explicitly allow provision-before-payment to continue",
    );
  }
  const plan = siteLicensePlan(order);
  const requestedId = targetSiteLicenseId(order, opts.existing_site_license_id);
  if (!requestedId && !plan) throw Error("site-license plan is required");
  const preflight = requestedId
    ? await preflightExistingSiteLicense({
        actorAccountId: opts.account_id,
        order,
        siteLicenseId: requestedId,
        plan,
      })
    : undefined;
  const existingMismatches =
    requestedId && plan && preflight
      ? fulfillmentMismatches(plan, preflight)
      : [];
  const targetMismatches =
    preflight && !plan && !order.site_license_id
      ? namedTargetMismatches(order, preflight)
      : [];
  if (targetMismatches.length && !opts.allow_target_mismatch) {
    throw Error(namedTargetMismatchError(targetMismatches));
  }
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    operation: "provision-site-license",
    expected_version: opts.expected_version,
    idempotency_key: key,
    request: operationRequest,
    exclusive: true,
  });
  if (reservation.operation.status === "succeeded") {
    return await getCommercialOrder(order.id);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    let siteLicenseId =
      requestedId ?? (await findRecoveredSiteLicense(order.id));
    let current: SiteLicenseOverview;
    if (!siteLicenseId) {
      current = await adminProvisionSiteLicense({
        actor_account_id: opts.account_id,
        owner_account_id: plan!.owner_account_id,
        name: plan!.name,
        organization_name: plan!.organization_name ?? order.organization_name,
        allowed_domains: plan!.allowed_domains,
        pools: plan!.pools.map((pool) => poolConfig(plan!, pool)),
        custom_terms_url: plan!.custom_terms_url,
        custom_policy_url: plan!.custom_policy_url,
        terms_version_label: plan!.terms_version_label,
        renewal_policy: plan!.renewal_policy,
        overage_policy: plan!.overage_policy,
        starts_at: plan!.starts_at,
        expires_at: plan!.expires_at,
        metadata: {
          ...(plan!.metadata ?? {}),
          commercial_order_id: order.id,
          commercial_order_number: order.order_number,
        },
        trusted_admin: true,
      });
      siteLicenseId = current.site_license.id;
      for (const manager of plan!.manager_account_ids ?? []) {
        if (manager === plan!.owner_account_id) continue;
        await setSiteLicenseManager({
          actor_account_id: opts.account_id,
          site_license_id: siteLicenseId,
          target_account_id: manager,
          role: "manager",
        });
      }
    } else if (plan) {
      current = await applyPlanToExisting({
        actorAccountId: opts.account_id,
        siteLicenseId,
        orderId: order.id,
        orderNumber: order.order_number,
        plan,
        current:
          preflight ??
          (await preflightExistingSiteLicense({
            actorAccountId: opts.account_id,
            order,
            siteLicenseId,
            plan,
          })),
      });
    } else {
      current = await updateSiteLicense({
        actor_account_id: opts.account_id,
        site_license_id: siteLicenseId,
        metadata: {
          commercial_order_id: order.id,
          commercial_order_number: order.order_number,
        },
      });
    }
    if (plan) {
      current = await overview(opts.account_id, siteLicenseId);
      const mismatches = fulfillmentMismatches(plan, current);
      if (mismatches.length) {
        throw Error(
          `provisioned site license does not match the order: ${mismatches.join(", ")}`,
        );
      }
    }
    const updated = await setCommercialFulfillment({
      id: order.id,
      account_id: opts.account_id,
      expected_version: order.version,
      reason,
      source: opts.source,
      idempotency_key: `${key}:local`,
      fulfillment_state: "provisioned",
      site_license_id: siteLicenseId,
      metadata: {
        allow_before_payment: opts.allow_before_payment === true,
        ...(targetMismatches.length
          ? { accepted_target_mismatches: targetMismatches }
          : {}),
        action: requestedId
          ? existingMismatches.length ||
            !preflight?.site_license.metadata?.commercial_order_id
            ? "updated"
            : "linked"
          : "created",
      },
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { site_license_id: siteLicenseId },
    });
    return updated;
  } catch (err) {
    recordCommercialProviderFailure("site-license-provision");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}

function isExpired(value: Date | string | null | undefined): boolean {
  return value != null && dateValue(value) <= Date.now();
}

export async function endCommercialSiteLicenseFulfillment(
  opts: CommercialOrderTransitionRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  const order = await getCommercialOrder(opts.id);
  if (order.fulfillment_state === "ended") return order;
  if (order.fulfillment_state !== "provisioned" || !order.site_license_id) {
    throw Error("commercial fulfillment was never provisioned");
  }
  if (order.workflow_state === "cancelled") {
    throw Error("cancelled commercial fulfillment cannot be ended");
  }
  const plan = siteLicensePlan(order);
  const current = await preflightExistingSiteLicense({
    actorAccountId: opts.account_id,
    order,
    siteLicenseId: order.site_license_id,
    plan,
  });
  const key = commercialIdempotencyKey("site-license-end", opts as any);
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    operation: "end-site-license",
    expected_version: opts.expected_version,
    idempotency_key: key,
    request: { site_license_id: order.site_license_id },
  });
  if (reservation.operation.status === "succeeded") {
    return await getCommercialOrder(order.id);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    const endedAt = new Date(Date.now() - 1_000).toISOString();
    for (const pool of current.pools) {
      if (!isExpired(pool.expires_at)) {
        await updateSiteLicensePool({
          actor_account_id: opts.account_id,
          package_id: pool.id,
          expires_at: endedAt,
        });
      }
    }
    if (!isExpired(current.site_license.expires_at)) {
      await updateSiteLicense({
        actor_account_id: opts.account_id,
        site_license_id: order.site_license_id,
        expires_at: endedAt,
      });
    }
    const ended = await overview(opts.account_id, order.site_license_id);
    if (
      !isExpired(ended.site_license.expires_at) ||
      ended.pools.some(({ expires_at }) => !isExpired(expires_at))
    ) {
      throw Error(
        "site license access is still active after ending fulfillment",
      );
    }
    const updated = await setCommercialFulfillment({
      id: order.id,
      account_id: opts.account_id,
      expected_version: order.version,
      reason,
      source: opts.source,
      idempotency_key: `${key}:local`,
      fulfillment_state: "ended",
      site_license_id: order.site_license_id,
      metadata: { ended_at: endedAt },
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { site_license_id: order.site_license_id, ended_at: endedAt },
    });
    return updated;
  } catch (err) {
    recordCommercialProviderFailure("site-license-end");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}
