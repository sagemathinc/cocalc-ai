import { z } from "../../framework";

import {
  FailedAPIOperationSchema,
  SuccessfulAPIOperationSchema,
} from "../common";

import { AccountIdSchema } from "./common";

// OpenAPI spec
//
export const SetAccountNameInputSchema = z
  .object({
    account_id: AccountIdSchema.optional().describe(
      `**Administrators only**. Optional account id to set name(s) for. If this field is 
       not provided, it is assumed that this operation pertains to the account id of the 
       user making the request.`,
    ),
    display_name: z.string().max(254).describe("Display name").optional(),
    first_name: z
      .string()
      .max(254)
      .describe("Legacy first name; used only to derive display_name")
      .optional(),
    last_name: z
      .string()
      .max(254)
      .describe("Legacy last name; used only to derive display_name")
      .optional(),
  })
  .describe(
    `Set the display name for a user account. Legacy first_name and last_name
     inputs are accepted only to derive display_name for older clients.`,
  );

export const SetAccountNameOutputSchema = z.union([
  FailedAPIOperationSchema,
  SuccessfulAPIOperationSchema,
]);

export type SetAccountNameInput = z.infer<typeof SetAccountNameInputSchema>;
export type SetAccountNameOutput = z.infer<typeof SetAccountNameOutputSchema>;
