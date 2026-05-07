/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getTransactionClient, type PoolClient } from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import type { MembershipPackageProduct } from "@cocalc/util/db-schema/shopping-cart-items";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/server/accounts/rehome-fence";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import { assertPurchaseAllowed } from "@cocalc/server/purchases/is-purchase-allowed";
import isValidAccount from "@cocalc/server/accounts/is-valid-account";
import {
  addMembershipPackageSeats,
  createMembershipPackage,
  getMembershipPackage,
  resolveMembershipPackageQuote,
  setMembershipPackagePurchaseId,
} from "@cocalc/server/membership/packages";

const logger = getLogger("purchases:membership-package");

export async function createMembershipPackagePurchase(
  {
    account_id,
    product,
  }: {
    account_id: string;
    product: MembershipPackageProduct;
  },
  client: PoolClient,
): Promise<{ package_id: string; purchase_id: number }> {
  if (!(await isValidAccount(account_id))) {
    throw Error(`invalid account_id - ${account_id}`);
  }
  if (product?.type !== "membership-package") {
    throw Error("product type must be 'membership-package'");
  }
  await assertAccountNotRehoming({
    db: client,
    account_id,
    action: "purchase membership package",
  });
  await assertAccountWriteOnHomeBay({
    db: client,
    account_id,
    action: "purchase membership package",
  });

  const existingPackageId = `${product.package_id ?? ""}`.trim();
  if (existingPackageId) {
    const existingPackage = await getMembershipPackage({
      package_id: existingPackageId,
      client,
    });
    if (!existingPackage) {
      throw Error("membership package not found");
    }
    if (existingPackage.owner_account_id !== account_id) {
      throw Error("must own membership package");
    }
  }

  const quote = await resolveMembershipPackageQuote(product, client);
  let package_id = existingPackageId;
  const expandingExistingPackage = !!package_id;

  if (expandingExistingPackage) {
    await addMembershipPackageSeats(
      {
        package_id,
        seat_count: quote.seat_count,
      },
      client,
    );
  } else {
    package_id = await createMembershipPackage(
      {
        owner_account_id: account_id,
        kind: quote.kind,
        membership_class: quote.membership_class,
        seat_count: quote.seat_count,
        starts_at: quote.starts_at,
        expires_at: quote.expires_at,
        metadata: quote.metadata ?? null,
      },
      client,
    );
  }

  const purchase_id = await createPurchase({
    account_id,
    cost: quote.total_price,
    unrounded_cost: quote.total_price,
    service: "membership",
    description: {
      type: "membership-package",
      package_id,
      kind: quote.kind,
      membership_class: quote.membership_class,
      seat_count: quote.seat_count,
      seat_price: quote.seat_price,
      total_price: quote.total_price,
      starts_at: quote.starts_at,
      expires_at: quote.expires_at,
      interval: quote.interval,
      expanded_existing_package: expandingExistingPackage,
      metadata: quote.metadata ?? null,
    },
    tag: expandingExistingPackage
      ? "membership-package-expand"
      : "membership-package-purchase",
    period_start: quote.starts_at,
    period_end: quote.expires_at,
    client,
  });

  if (!expandingExistingPackage) {
    await setMembershipPackagePurchaseId(
      {
        package_id,
        purchase_id,
      },
      client,
    );
  }

  return { package_id, purchase_id };
}

export default async function purchaseMembershipPackage({
  account_id,
  product,
  amount,
}: {
  account_id: string;
  product: MembershipPackageProduct;
  amount?: number;
}): Promise<{ package_id: string; purchase_id: number }> {
  logger.debug("purchaseMembershipPackage", {
    account_id,
    product,
    amount,
  });
  const quote = await resolveMembershipPackageQuote(product);
  const client = await getTransactionClient();
  try {
    await assertPurchaseAllowed({
      account_id,
      service: "membership",
      cost: quote.total_price,
      client,
      amount,
    });
    const result = await createMembershipPackagePurchase(
      {
        account_id,
        product,
      },
      client,
    );
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
