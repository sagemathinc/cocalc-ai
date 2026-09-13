/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { StripeClient } from "@cocalc/server/stripe/client";
import adminPurchase from "@cocalc/server/purchases/admin-purchase";
import cancelSubscription from "@cocalc/server/purchases/cancel-subscription";
import createRefund from "@cocalc/server/purchases/create-refund";
import maintainAutoBalance from "@cocalc/server/purchases/maintain-auto-balance";
import maintainAutomaticPayments from "@cocalc/server/purchases/maintain-automatic-payments";
import maintainSubscriptions from "@cocalc/server/purchases/maintain-subscriptions";
import maintainTeamLicenses from "@cocalc/server/purchases/maintain-team-licenses";
import { applyMembershipChange } from "@cocalc/server/purchases/membership-change";
import renewSubscription from "@cocalc/server/purchases/renew-subscription";
import resumeSubscription from "@cocalc/server/purchases/resume-subscription";
import maintainStatements from "@cocalc/server/purchases/statements/maintenance";
import {
  cancelPaymentIntent,
  default as createPaymentIntent,
  getPaymentIntentAccountId,
} from "@cocalc/server/purchases/stripe/create-payment-intent";
import createSetupIntent from "@cocalc/server/purchases/stripe/create-setup-intent";
import createSubscriptionPayment from "@cocalc/server/purchases/stripe/create-subscription-payment";
import { setCustomer } from "@cocalc/server/purchases/stripe/customer";
import deletePaymentMethod from "@cocalc/server/purchases/stripe/delete-payment-method";
import getCheckoutSession from "@cocalc/server/purchases/stripe/get-checkout-session";
import { getCustomer } from "@cocalc/server/purchases/stripe/customer";
import getCustomerSession from "@cocalc/server/purchases/stripe/get-customer-session";
import getPaymentMethods, {
  getPaymentMethod,
} from "@cocalc/server/purchases/stripe/get-payment-methods";
import getPayments, {
  getAllOpenPayments,
} from "@cocalc/server/purchases/stripe/get-payments";
import {
  getInvoice,
  getInvoiceUrl,
} from "@cocalc/server/purchases/stripe/invoices";
import getUnpaidInvoices from "@cocalc/server/purchases/get-unpaid-invoices";
import { getBillingReadiness } from "@cocalc/server/purchases/stripe/billing-readiness";
import processPaymentIntents, {
  maintainPaymentIntents,
} from "@cocalc/server/purchases/stripe/process-payment-intents";
import setDefaultPaymentMethod from "@cocalc/server/purchases/stripe/set-default-payment-method";
import { processStripeWebhookEvent } from "@cocalc/server/purchases/stripe/webhook";
import { cancelUsageSubscription } from "@cocalc/server/purchases/stripe-usage-based-subscription";
import { runCommercialReceivablesAuthorityTask } from "@cocalc/server/commercial-orders/maintenance-task";
import { dispatchCommercialSeedRequest } from "@cocalc/server/commercial-orders/dispatch";
import {
  cancelOpenPaymentIntentsForQuarantine,
  detachPaymentMethodsForQuarantine,
} from "@cocalc/server/accounts/resource-quarantine-stripe";
import syncPaidInvoices from "@cocalc/server/purchases/sync-paid-invoices";
import { reconcileLegacyPaymentIntentCredit } from "@cocalc/server/purchases/stripe-usage-based-subscription";
import { purchaseTeamLicenseChange } from "@cocalc/server/purchases/team-license";
import adminCreateMembershipPackagePurchase from "@cocalc/server/purchases/admin-membership-package";
import * as legacyMigration from "@cocalc/server/legacy-migration";

import type {
  BillingAuthorityCommand,
  BillingAuthorityHubApiCall,
} from "./protocol";

type HubApiExecutor = (call: BillingAuthorityHubApiCall) => Promise<unknown>;
let hubApiExecutor: HubApiExecutor | undefined;

export function registerBillingAuthorityHubApiExecutor(
  executor: HubApiExecutor,
): void {
  if (hubApiExecutor && hubApiExecutor !== executor) {
    throw Error("billing authority Hub API executor is already registered");
  }
  hubApiExecutor = executor;
}

function requireHubApiExecutor(): HubApiExecutor {
  if (!hubApiExecutor) {
    throw Error("billing authority Hub API executor is not registered");
  }
  return hubApiExecutor;
}

async function dispatchHttp(
  operation: Extract<BillingAuthorityCommand, { kind: "http" }>["operation"],
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (operation) {
    case "admin-purchase":
      return await adminPurchase(input as any);
    case "cancel-payment-intent":
      await cancelPaymentIntent(input as any);
      return { success: true };
    case "cancel-subscription":
      await cancelSubscription(input as any);
      return null;
    case "create-payment-intent":
      return await createPaymentIntent(input as any);
    case "create-refund":
      return await createRefund(input as any);
    case "create-setup-intent":
      return await createSetupIntent(input as any);
    case "create-subscription-payment":
      await createSubscriptionPayment(input as any);
      return null;
    case "delete-payment-method":
      await deletePaymentMethod(input as any);
      return null;
    case "get-billing-readiness":
      return await getBillingReadiness(`${input.account_id ?? ""}`);
    case "get-checkout-session":
      return await getCheckoutSession(input as any);
    case "get-customer":
      return await getCustomer(`${input.account_id ?? ""}`);
    case "get-customer-session":
      return await getCustomerSession(`${input.account_id ?? ""}`);
    case "get-invoice":
      return await getInvoice(input as any);
    case "get-invoice-url":
      return await getInvoiceUrl(input as any);
    case "get-open-payments":
      return await getAllOpenPayments(
        `${input.account_id ?? ""}`,
        input.canceled === true,
      );
    case "get-payment-intent-account-id":
      return await getPaymentIntentAccountId(`${input.id ?? ""}`);
    case "get-payment-method":
      return await getPaymentMethod(input as any);
    case "get-payment-methods":
      return await getPaymentMethods(input as any);
    case "get-payments":
      return await getPayments(input as any);
    case "get-unpaid-invoices":
      return await getUnpaidInvoices(`${input.account_id ?? ""}`);
    case "membership-change":
      return await applyMembershipChange(input as any);
    case "process-payment-intents":
      return await processPaymentIntents(input as any);
    case "renew-subscription":
      return await renewSubscription(input as any);
    case "resume-subscription":
      await resumeSubscription(input as any);
      return null;
    case "set-customer":
      await setCustomer(
        `${input.account_id ?? ""}`,
        input.changes as Parameters<typeof setCustomer>[1],
      );
      return null;
    case "set-default-payment-method":
      await setDefaultPaymentMethod(input as any);
      return null;
    default:
      throw new Error(`unsupported billing HTTP operation '${operation}'`);
  }
}

async function dispatchAccountLocal(
  operation: Extract<
    BillingAuthorityCommand,
    { kind: "account-local" }
  >["operation"],
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (operation) {
    case "admin-create-membership-package-purchase":
      return await adminCreateMembershipPackagePurchase(input as any);
    case "legacy-apply-financial-home-bay":
      return await legacyMigration.applyFinancialMigrationHomeBay(input as any);
    case "legacy-apply-financial-migration":
      return await legacyMigration.applyFinancialMigration(input as any);
    case "legacy-configure-financial-renewal-home-bay":
      return await legacyMigration.configureFinancialMembershipRenewalHomeBay(
        input as any,
      );
    case "purchase-team-license-change":
      return await purchaseTeamLicenseChange(input as any);
    default:
      throw new Error(
        `unsupported account-local billing operation '${operation}'`,
      );
  }
}

async function dispatchMaintenance(
  task: Extract<BillingAuthorityCommand, { kind: "maintenance" }>["task"],
): Promise<void> {
  switch (task) {
    case "automatic-payments":
      return await maintainAutomaticPayments({ max_statements: 1 });
    case "auto-balance":
      return await maintainAutoBalance({ max_accounts: 1 });
    case "payment-intents":
      return await maintainPaymentIntents({ max_payment_intents: 1 });
    case "statements":
      return await maintainStatements({ max_emails: 1 });
    case "subscriptions":
      return await maintainSubscriptions({
        max_notifications: 1,
        max_renewals: 1,
      });
    case "team-licenses":
      return await maintainTeamLicenses({ max_licenses: 1 });
    default:
      throw new Error(`unsupported billing maintenance task '${task}'`);
  }
}

export async function dispatchBillingAuthorityCommand(
  command: BillingAuthorityCommand,
): Promise<unknown> {
  switch (command.kind) {
    case "account-local":
      return await dispatchAccountLocal(command.operation, command.input);
    case "account-stripe-cleanup":
      return await new StripeClient({
        account_id: command.account_id,
      }).cancelEverything();
    case "cancel-usage-subscription":
      return await cancelUsageSubscription(command.account_id);
    case "quarantine-account-stripe-cleanup": {
      await cancelUsageSubscription(command.account_id);
      const payment_intents_canceled =
        await cancelOpenPaymentIntentsForQuarantine(command.account_id);
      const payment_methods_detached = await detachPaymentMethodsForQuarantine(
        command.account_id,
      );
      return {
        usage_subscription_canceled: true,
        payment_intents_canceled,
        payment_methods_detached,
      };
    }
    case "quarantine-stripe-resources":
      return command.action === "cancel-payment-intents"
        ? await cancelOpenPaymentIntentsForQuarantine(command.account_id)
        : await detachPaymentMethodsForQuarantine(command.account_id);
    case "commercial-maintenance":
      return await runCommercialReceivablesAuthorityTask();
    case "commercial-seed":
      return await dispatchCommercialSeedRequest(command.request);
    case "http":
      return await dispatchHttp(command.operation, command.input);
    case "hub-api":
      return await requireHubApiExecutor()(command.call);
    case "maintenance":
      return await dispatchMaintenance(command.task);
    case "reconcile-legacy-credit":
      return command.source.kind === "paid-invoices"
        ? await syncPaidInvoices(command.source.account_id)
        : await reconcileLegacyPaymentIntentCredit(
            command.source.payment_intent_id,
          );
    case "stripe-webhook":
      return await processStripeWebhookEvent(command.event);
    default:
      throw new Error(
        `unsupported billing authority command '${(command as any)?.kind}'`,
      );
  }
}
