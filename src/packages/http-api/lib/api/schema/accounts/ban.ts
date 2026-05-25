import { z } from "../../framework";

import {
  FailedAPIOperationSchema,
  SuccessfulAPIOperationSchema,
} from "../common";

import { AccountIdSchema } from "./common";

// OpenAPI spec
//
export const BanAccountInputSchema = z
  .object({
    account_id: AccountIdSchema.describe("Account id to ban."),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .optional()
      .describe("Admin-entered reason recorded in the ban audit log."),
  })
  .describe(
    "**Administrators only**. Used to ban a user's account from the system.",
  );

export const BanAccountOutputSchema = z.union([
  FailedAPIOperationSchema,
  SuccessfulAPIOperationSchema,
]);

export type BanAccountInput = z.infer<typeof BanAccountInputSchema>;
export type BanAccountOutput = z.infer<typeof BanAccountOutputSchema>;
