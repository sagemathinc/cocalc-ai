/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Record fulfillment of a membership-seat commercial order.

The site-license adapter provisions site licenses itself. Membership-seat
orders (items of product_kind "membership_package") are fulfilled by an admin
creating membership packages for the customer (`admin purchase
membership-package`, sometimes as a bridge before payment). This records that
fulfillment on the order, so a paid order does not stay at "Provision service"
forever, and keeps references to the packages that fulfil it. It only records:
it never creates, changes or ends a package.

Membership packages are account-home state, so they are read through the
customer's home bay (the commercial order lives on the seed), and each one
must be evidence for this specific order: owned by the order's customer,
created for this order (metadata.commercial_order_number or
commercial_order_id), not a site-license pool, already active, and covering
the order's service term.
*/

import type { CommercialMembershipFulfillmentRequest } from "@cocalc/conat/hub/api/commercial-orders";
import type { MembershipPackageRecord } from "@cocalc/conat/hub/api/purchases";
import type { CommercialOrder } from "@cocalc/util/commercial-orders";
import { isValidUUID } from "@cocalc/util/misc";
import {
  commercialIdempotencyKey,
  getCommercialOrder,
  setCommercialFulfillment,
} from "../store";
import { requireReason } from "../state";

const MAX_PACKAGES = 20;

function normalizePackageIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw Error("at least one membership package id is required");
  }
  const normalized = Array.from(
    new Set(ids.map((id) => `${id ?? ""}`.trim().toLowerCase())),
  );
  if (normalized.length > MAX_PACKAGES) {
    throw Error(`at most ${MAX_PACKAGES} membership packages can be recorded`);
  }
  for (const id of normalized) {
    if (!isValidUUID(id)) {
      throw Error(`invalid membership package id '${id}'`);
    }
  }
  return normalized;
}

// Properties of the order that do not change once it is provisioned; the
// current fulfillment state is checked inside setCommercialFulfillment, after
// an exact replay has been returned.
function assertMembershipOrder(order: CommercialOrder): void {
  if (order.workflow_state === "cancelled") {
    throw Error("fulfillment is not allowed on a cancelled order");
  }
  if (order.site_license_id) {
    throw Error(
      "this order has a site license; use `fulfillment provision` instead",
    );
  }
  const kinds = (order.items ?? []).map((item) => item.product_kind);
  if (
    kinds.length === 0 ||
    kinds.some((kind) => kind !== "membership_package")
  ) {
    throw Error(
      "only orders whose items are all membership packages can be fulfilled this way",
    );
  }
  if (!order.customer_account_id) {
    throw Error("the commercial order has no customer account");
  }
}

function time(value: unknown): number | undefined {
  if (value == null || value === "") return;
  const t = new Date(value as any).valueOf();
  return Number.isFinite(t) ? t : undefined;
}

function assertPackageFulfilsOrder(
  pkg: MembershipPackageRecord,
  order: CommercialOrder,
  now: number,
): void {
  const id = pkg.id;
  if (pkg.owner_account_id !== order.customer_account_id) {
    throw Error(
      `membership package ${id} is not owned by the order's customer account`,
    );
  }
  if (pkg.kind === "site") {
    throw Error(`membership package ${id} is a site-license pool`);
  }
  const metadata = (pkg.metadata ?? {}) as Record<string, unknown>;
  if (
    metadata.commercial_order_number !== order.order_number &&
    metadata.commercial_order_id !== order.id
  ) {
    throw Error(
      `membership package ${id} was not created for ${order.order_number}`,
    );
  }
  const starts = time(pkg.starts_at);
  if (starts != null && starts > now) {
    throw Error(`membership package ${id} has not started yet`);
  }
  const expires = time(pkg.expires_at);
  if (expires != null && expires <= now) {
    throw Error(`membership package ${id} has already expired`);
  }
  const serviceEnds = time(order.service_ends_at);
  if (expires != null && serviceEnds != null && expires < serviceEnds) {
    throw Error(
      `membership package ${id} ends before the order's service term`,
    );
  }
}

async function loadCustomerPackages({
  actor_account_id,
  customer_account_id,
}: {
  actor_account_id: string;
  customer_account_id: string;
}): Promise<MembershipPackageRecord[]> {
  // Routes to the customer's home bay (admin-only for another account).
  const { getMembershipPackages } =
    await import("@cocalc/server/conat/api/purchases");
  return await getMembershipPackages({
    account_id: actor_account_id,
    user_account_id: customer_account_id,
  });
}

export async function recordCommercialMembershipFulfillment(
  opts: CommercialMembershipFulfillmentRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  const packageIds = normalizePackageIds(opts.membership_package_ids);
  const order = await getCommercialOrder(opts.id);
  assertMembershipOrder(order);

  const packages = await loadCustomerPackages({
    actor_account_id: opts.account_id,
    customer_account_id: order.customer_account_id!,
  });
  const byId = new Map(packages.map((pkg) => [`${pkg.id}`.toLowerCase(), pkg]));
  const now = Date.now();
  for (const id of packageIds) {
    const pkg = byId.get(id);
    if (pkg == null) {
      throw Error(
        `membership package ${id} not found for the order's customer account`,
      );
    }
    assertPackageFulfilsOrder(pkg, order, now);
  }

  return await setCommercialFulfillment({
    id: order.id,
    account_id: opts.account_id,
    expected_version: opts.expected_version,
    reason,
    source: opts.source,
    idempotency_key: commercialIdempotencyKey(
      "membership-fulfillment",
      opts as any,
    ),
    fulfillment_state: "provisioned",
    expected_fulfillment_state: "not_provisioned",
    metadata: {
      membership_package_ids: packageIds,
      membership_packages: packageIds.map((id) => {
        const pkg = byId.get(id)!;
        return {
          id,
          kind: pkg.kind,
          membership_class: pkg.membership_class,
          seat_count: pkg.seat_count,
          starts_at: pkg.starts_at
            ? new Date(pkg.starts_at).toISOString()
            : null,
          expires_at: pkg.expires_at
            ? new Date(pkg.expires_at).toISOString()
            : null,
        };
      }),
    },
  });
}
