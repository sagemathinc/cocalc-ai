/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import { moneyRound2Up, toDecimal, type MoneyValue } from "@cocalc/util/money";
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
    invoice_id,
    product,
  }: {
    account_id: string;
    invoice_id?: string;
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
  const existingPurchase = await getExistingMembershipPackagePurchase({
    account_id,
    invoice_id,
    client,
  });
  if (existingPurchase) {
    return existingPurchase;
  }

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
    invoice_id,
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
  fulfillment_id,
  product,
  amount,
}: {
  account_id: string;
  fulfillment_id?: string;
  product: MembershipPackageProduct;
  amount?: number;
}): Promise<{ package_id: string; purchase_id: number }> {
  logger.debug("purchaseMembershipPackage", {
    account_id,
    product,
    amount,
  });
  const quote = await resolveMembershipPackageQuote(product);
  const invoice_id = membershipPackageFulfillmentInvoiceId(fulfillment_id);
  const client = await getTransactionClient();
  try {
    const existingPurchase = await getExistingMembershipPackagePurchase({
      account_id,
      invoice_id,
      client,
    });
    if (existingPurchase) {
      await client.query("COMMIT");
      return existingPurchase;
    }
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
        invoice_id,
        product,
      },
      client,
    );
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    if (invoice_id && isUniqueViolation(err)) {
      const existingPurchase = await getExistingMembershipPackagePurchase({
        account_id,
        invoice_id,
      });
      if (existingPurchase) {
        return existingPurchase;
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function purchaseMembershipPackages({
  account_id,
  fulfillment_id,
  products,
  amount,
}: {
  account_id: string;
  fulfillment_id?: string;
  products: MembershipPackageProduct[];
  amount?: MoneyValue;
}): Promise<{ package_id: string; purchase_id: number }[]> {
  logger.debug("purchaseMembershipPackages", {
    account_id,
    products,
    amount,
  });
  if (products.length === 0) {
    throw Error("at least one membership package product is required");
  }
  const quotes = await Promise.all(
    products.map((product) => resolveMembershipPackageQuote(product)),
  );
  const total = moneyRound2Up(
    quotes.reduce(
      (sum, quote) => sum.add(toDecimal(quote.total_price)),
      toDecimal(0),
    ),
  );
  const client = await getTransactionClient();
  try {
    const invoiceIds = products.map((_product, index) =>
      membershipPackageFulfillmentInvoiceId(fulfillment_id, index),
    );
    const existingPurchases = await getExistingMembershipPackagePurchases({
      account_id,
      invoiceIds,
      client,
    });
    if (existingPurchases) {
      await client.query("COMMIT");
      return existingPurchases;
    }
    await assertPurchaseAllowed({
      account_id,
      service: "membership",
      cost: total,
      client,
      amount,
    });
    const results: { package_id: string; purchase_id: number }[] = [];
    for (const [index, product] of products.entries()) {
      results.push(
        await createMembershipPackagePurchase(
          {
            account_id,
            invoice_id: invoiceIds[index],
            product,
          },
          client,
        ),
      );
    }
    await client.query("COMMIT");
    return results;
  } catch (err) {
    await client.query("ROLLBACK");
    if (fulfillment_id && isUniqueViolation(err)) {
      const existingPurchases = await getExistingMembershipPackagePurchases({
        account_id,
        invoiceIds: products.map((_product, index) =>
          membershipPackageFulfillmentInvoiceId(fulfillment_id, index),
        ),
      });
      if (existingPurchases) {
        return existingPurchases;
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

function membershipPackageFulfillmentInvoiceId(
  fulfillment_id?: string,
  index = 0,
): string | undefined {
  const id = `${fulfillment_id ?? ""}`.trim();
  if (!id) {
    return undefined;
  }
  return `membership-package:${id}:${index}`;
}

async function getExistingMembershipPackagePurchase({
  account_id,
  invoice_id,
  client,
}: {
  account_id: string;
  invoice_id?: string;
  client?: PoolClient;
}): Promise<{ package_id: string; purchase_id: number } | undefined> {
  if (!invoice_id) {
    return undefined;
  }
  const { rows } = await (client ?? getPool("medium")).query(
    `SELECT id, description
       FROM purchases
      WHERE account_id=$1
        AND invoice_id=$2
        AND service='membership'
      LIMIT 1`,
    [account_id, invoice_id],
  );
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  const package_id = `${row.description?.package_id ?? ""}`.trim();
  if (row.description?.type !== "membership-package" || !package_id) {
    throw Error("membership package fulfillment id has incompatible purchase");
  }
  return { package_id, purchase_id: row.id };
}

async function getExistingMembershipPackagePurchases({
  account_id,
  invoiceIds,
  client,
}: {
  account_id: string;
  invoiceIds: (string | undefined)[];
  client?: PoolClient;
}): Promise<{ package_id: string; purchase_id: number }[] | undefined> {
  if (invoiceIds.some((invoiceId) => !invoiceId)) {
    return undefined;
  }
  const purchases: { package_id: string; purchase_id: number }[] = [];
  for (const invoice_id of invoiceIds) {
    const purchase = await getExistingMembershipPackagePurchase({
      account_id,
      invoice_id,
      client,
    });
    if (!purchase) {
      return undefined;
    }
    purchases.push(purchase);
  }
  return purchases;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}
