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
*/

import type { CommercialMembershipFulfillmentRequest } from "@cocalc/conat/hub/api/commercial-orders";
import getPool from "@cocalc/database/pool";
import type { CommercialOrder } from "@cocalc/util/commercial-orders";
import { isValidUUID } from "@cocalc/util/misc";
import {
  commercialIdempotencyKey,
  getCommercialOrder,
  setCommercialFulfillment,
} from "../store";
import { requireReason } from "../state";

const MAX_PACKAGES = 20;

interface PackageRow {
  id: string;
  owner_account_id: string | null;
  kind: string;
  membership_class: string;
  seat_count: number | null;
  starts_at: Date | null;
  expires_at: Date | null;
}

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

function assertMembershipOrder(order: CommercialOrder): void {
  if (order.workflow_state === "cancelled") {
    throw Error("fulfillment is not allowed on a cancelled order");
  }
  if (order.fulfillment_state !== "not_provisioned") {
    throw Error(`commercial fulfillment is already ${order.fulfillment_state}`);
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

  const { rows } = await getPool().query<PackageRow>(
    `SELECT id::text AS id, owner_account_id::text AS owner_account_id, kind,
            membership_class, seat_count, starts_at, expires_at
       FROM membership_packages
      WHERE id = ANY($1::uuid[])`,
    [packageIds],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const now = Date.now();
  for (const id of packageIds) {
    const pkg = byId.get(id);
    if (pkg == null) {
      throw Error(`membership package ${id} not found`);
    }
    if (pkg.owner_account_id !== order.customer_account_id) {
      throw Error(
        `membership package ${id} is not owned by the order's customer account`,
      );
    }
    if (pkg.expires_at != null && new Date(pkg.expires_at).valueOf() <= now) {
      throw Error(`membership package ${id} has already expired`);
    }
  }

  return await setCommercialFulfillment({
    id: order.id,
    account_id: opts.account_id,
    expected_version: opts.expected_version,
    reason,
    source: opts.source,
    idempotency_key:
      opts.idempotency_key ??
      commercialIdempotencyKey("membership-fulfillment", opts as any),
    fulfillment_state: "provisioned",
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
