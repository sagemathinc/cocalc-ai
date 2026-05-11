import { z } from "../../framework";

import {
  FailedAPIOperationSchema,
  SuccessfulAPIOperationSchema,
} from "../common";

import { AccountEmailSchema } from "./common";

// OpenAPI spec
//
export const SetAccountEmailAddressInputSchema = z
  .object({
    email_address: AccountEmailSchema,
    password: z.string().describe("The password for the account."),
  })
  .describe(
    `Set email address of an account. The password must also be provided. If the 
     email address is already set in the database, then \`password\` must be the current 
     correct password. If the email address is NOT set, then a new email address and 
     password are set.`,
  );

export const SetAccountEmailAddressOutputSchema = z.union([
  FailedAPIOperationSchema,
  SuccessfulAPIOperationSchema.extend({
    already_verified: z
      .boolean()
      .describe("Whether this email address was already verified."),
    email_address: AccountEmailSchema,
    verification_email_error: z
      .string()
      .describe("Error from sending the automatic verification email.")
      .optional(),
    verification_email_sent: z
      .boolean()
      .describe(
        "Whether a verification email was automatically sent for this change.",
      ),
  }),
]);

export type SetAccountEmailAddressInput = z.infer<
  typeof SetAccountEmailAddressInputSchema
>;
export type SetAccountEmailAddressOutput = z.infer<
  typeof SetAccountEmailAddressOutputSchema
>;
