/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import { resolveCourseFundingReview } from "./approval-review";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: jest.fn(),
}));
jest.mock("./backing", () => ({ withFundingAccountTransaction: jest.fn() }));
jest.mock("./course-access", () => ({ assertCourseAccess: jest.fn() }));
jest.mock("./rollout", () => ({ assertSponsorshipAdmission: jest.fn() }));
jest.mock("./approval-transfer", () => ({
  resolveTransferApprovalReview: jest.fn(),
}));
jest.mock("./pool-changes", () => ({
  previewCourseFundingPoolChangeInTransaction: jest.fn(),
}));
const terms = {
  recipients: [{ beneficiary_account_id: "student" }],
} as CourseFundingDraft;
it("resolves payer and recipient identities from the cluster directory, not course JSON", async () => {
  (getClusterAccountsByIds as jest.Mock).mockResolvedValue([
    {
      account_id: "payer",
      display_name: "Payer Name",
      email_address: "payer@example.test",
      home_bay_id: "bay-0",
    },
    {
      account_id: "student",
      first_name: "Student",
      last_name: "Name",
      email_address: "student@example.test",
      home_bay_id: "bay-0",
    },
  ]);
  expect(await resolveCourseFundingReview("payer", terms)).toEqual({
    payer: {
      account_id: "payer",
      name: "Payer Name",
      email: "payer@example.test",
      home_bay_id: "bay-0",
    },
    recipients: [
      {
        account_id: "student",
        name: "Student Name",
        email: "student@example.test",
        home_bay_id: "bay-0",
      },
    ],
    storage_retention_hours: 72,
  });
});
it("rejects missing identities and banned recipients instead of showing UUID-only approval", async () => {
  for (const recipient of [
    undefined,
    { account_id: "student" },
    {
      account_id: "student",
      email_address: "student@example.test",
      banned: true,
    },
  ]) {
    (getClusterAccountsByIds as jest.Mock).mockResolvedValue([
      {
        account_id: "payer",
        email_address: "payer@example.test",
        home_bay_id: "bay-0",
      },
      ...(recipient ? [recipient] : []),
    ]);
    await expect(resolveCourseFundingReview("payer", terms)).rejects.toThrow();
  }
});
