import { z } from "../../framework";

import {
  FailedAPIOperationSchema,
  SuccessfulAPIOperationSchema,
} from "../common";

import { AccountIdSchema } from "./common";

export const QuarantineBillingResourcesInputSchema = z
  .object({
    account_id: AccountIdSchema.describe("Account id to quarantine."),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe("Admin-entered reason recorded in the quarantine audit log."),
  })
  .describe(
    "**Administrators only**. Quarantines account billing and paid resources without deleting account data.",
  );

const QuarantineBillingResourcesResultSchema = z.object({
  account_id: AccountIdSchema,
  home_bay_id: z.string(),
  auto_balance_disabled: z.boolean(),
  checkout_session_cleared: z.boolean(),
  usage_subscription_canceled: z.boolean(),
  local_subscriptions_canceled: z.number(),
  payment_intents_canceled: z.number(),
  payment_methods_detached: z.number(),
  hosts_stop_requested: z.number(),
  host_ids: z.array(z.string()),
  errors: z.array(z.string()),
});

export const QuarantineBillingResourcesOutputSchema = z.union([
  FailedAPIOperationSchema,
  SuccessfulAPIOperationSchema.merge(
    z.object({
      result: QuarantineBillingResourcesResultSchema,
    }),
  ),
]);

export type QuarantineBillingResourcesInput = z.infer<
  typeof QuarantineBillingResourcesInputSchema
>;
export type QuarantineBillingResourcesOutput = z.infer<
  typeof QuarantineBillingResourcesOutputSchema
>;
