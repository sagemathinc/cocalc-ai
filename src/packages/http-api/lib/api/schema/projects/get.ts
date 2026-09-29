import { z } from "../../framework";

import { FailedAPIOperationSchema } from "../common";

import { AdminAccountIdSchema } from "../accounts/common";

import { ProjectIdSchema } from "./common";

// OpenAPI spec
//
export const GetAccountProjectsInputSchema = z
  .object({
    account_id: AdminAccountIdSchema,
    limit: z
      .number()
      .default(50)
      .describe("Upper bound on the number of projects to return.")
      .nullish(),
    offset: z.number().int().min(0).max(100_000).optional(),
    search: z.string().max(200).nullish(),
  })
  .describe(
    "Gets projects for a particular account. API keys use bounded pages of at most 500 projects and 2 MiB; when X-CoCalc-Next-Offset is present, pass that offset for the next page.",
  );

export const GetAccountProjectsOutputSchema = z.union([
  FailedAPIOperationSchema,
  z
    .array(
      z.object({
        project_id: ProjectIdSchema,
        title: z.string().nullish(),
        description: z.string().nullish(),
      }),
    )
    .describe("An array of projects corresponding to a particular account."),
]);

export type GetAccountProjectsInput = z.infer<
  typeof GetAccountProjectsInputSchema
>;
export type GetAccountProjectsOutput = z.infer<
  typeof GetAccountProjectsOutputSchema
>;
