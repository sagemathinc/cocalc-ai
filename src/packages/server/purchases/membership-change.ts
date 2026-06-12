import dayjs from "dayjs";

import { getTransactionClient, PoolClient } from "@cocalc/database/pool";
import { isPurchaseAllowed } from "@cocalc/server/purchases/is-purchase-allowed";
import {
  computeMembershipChange,
  MembershipChangeResult,
} from "@cocalc/server/membership/tiers";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import createSubscription from "@cocalc/server/purchases/create-subscription";
import { MembershipClass } from "@cocalc/conat/hub/api/purchases";
import { toDecimal, type MoneyValue } from "@cocalc/util/money";
import { assertPurchaseAllowed } from "@cocalc/server/purchases/is-purchase-allowed";
import { claimMembershipTrial } from "@cocalc/server/membership/trials";
import { assertBillingReady } from "@cocalc/server/purchases/stripe/billing-readiness";

interface MembershipChangeOptions {
  account_id: string;
  targetClass: MembershipClass;
  interval: "month" | "year";
  allowDowngrade?: boolean;
  storeVisibleOnly?: boolean;
  requireNoPayment?: boolean;
  paymentAmount?: MoneyValue;
  client?: PoolClient;
}

export async function applyMembershipChange({
  account_id,
  targetClass,
  interval,
  allowDowngrade = false,
  storeVisibleOnly = false,
  requireNoPayment = false,
  paymentAmount,
  client,
}: MembershipChangeOptions): Promise<
  MembershipChangeResult & { subscription_id: number; purchase_id?: number }
> {
  const transaction = client ?? (await getTransactionClient());
  const useTransaction = client == null;
  try {
    const change = await computeMembershipChange({
      account_id,
      targetClass,
      interval,
      allowDowngrade,
      storeVisibleOnly,
      client: transaction,
    });
    const chargeValue = toDecimal(change.charge);

    if (paymentAmount != null) {
      await assertPurchaseAllowed({
        account_id,
        service: "membership",
        cost: chargeValue,
        amount: paymentAmount,
        client: transaction,
      });
    }

    if (requireNoPayment && chargeValue.gt(0)) {
      const purchase = await isPurchaseAllowed({
        account_id,
        service: "membership",
        cost: chargeValue,
        client: transaction,
      });
      const chargeAmount = toDecimal(purchase.chargeAmount ?? change.charge);
      if (!purchase.allowed) {
        throw Error(purchase.reason ?? "purchase not allowed");
      }
      if (chargeAmount.gt(0)) {
        throw Error("payment required");
      }
    }

    if (change.existing_subscription_id) {
      await transaction.query(
        "UPDATE subscriptions SET status='canceled', canceled_at=NOW(), canceled_reason=$1 WHERE id=$2",
        [
          `Changed membership to ${targetClass}`,
          change.existing_subscription_id,
        ],
      );
    }

    const start = dayjs().toDate();
    const existingEnd = change.current_period_end;
    const trialDays = change.trial_days ?? 0;
    const isTrial =
      change.change == "new" &&
      change.trial_available === true &&
      trialDays > 0;
    if (isTrial) {
      await assertBillingReady(account_id);
    }
    const end = isTrial
      ? dayjs(start).add(trialDays, "day").toDate()
      : change.change == "downgrade" &&
          existingEnd != null &&
          existingEnd > start
        ? existingEnd
        : interval == "month"
          ? dayjs(start).add(1, "month").toDate()
          : dayjs(start).add(1, "year").toDate();

    const subscription_id = await createSubscription(
      {
        account_id,
        cost: change.price,
        interval,
        current_period_start: start,
        current_period_end: end,
        status: "active",
        metadata: {
          type: "membership",
          class: targetClass,
          ...(isTrial
            ? {
                trial: true,
                trial_days: trialDays,
                trial_email: change.trial_email,
                trial_ends_at: end.toISOString(),
              }
            : {}),
        },
      },
      transaction,
    );

    let purchase_id: number | undefined = undefined;
    if (chargeValue.gt(0)) {
      purchase_id = await createPurchase({
        account_id,
        cost: chargeValue,
        unrounded_cost: chargeValue,
        service: "membership",
        description: {
          type: "membership",
          subscription_id,
          class: targetClass,
          interval,
          ...(isTrial ? { trial_days: trialDays } : {}),
        },
        tag: "membership-change",
        period_start: start,
        period_end: end,
        client: transaction,
      });

      await transaction.query(
        "UPDATE subscriptions SET latest_purchase_id=$1 WHERE id=$2",
        [purchase_id, subscription_id],
      );
    }

    if (isTrial) {
      await claimMembershipTrial({
        account_id,
        email_address: change.trial_email ?? "",
        membership_class: targetClass,
        subscription_id,
        purchase_id,
        client: transaction,
      });
    }

    if (useTransaction) {
      await transaction.query("COMMIT");
    }

    return { ...change, subscription_id, purchase_id };
  } catch (err) {
    if (useTransaction) {
      await transaction.query("ROLLBACK");
    }
    throw err;
  } finally {
    if (useTransaction) {
      transaction.release();
    }
  }
}
