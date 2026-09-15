/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import {
  getVmPersonalFundingApprovalHandler,
  normalizePersonalVmApprovalTerms,
  registerVmPersonalFundingApprovalHandler,
  validatePersonalVmApprovalReview,
} from "./approval-personal";
import type {
  PersonalVmApprovalTerms,
  PersonalVmApprovalReview,
} from "./approval-personal";

const payer = randomUUID();
const terms: PersonalVmApprovalTerms = {
  kind: "personalVMfallback",
  vm_id: randomUUID(),
  expected_funding_version: "epoch:version:1",
  home_volume_ids: [],
  lane: "prepaid",
  cap_usd: "5.00",
  ends_at: "2099-10-01T12:00:00Z",
  activation: "fallback",
  fallback_reasons: ["course_exhausted", "course_expired"],
};
const review: PersonalVmApprovalReview = {
  vm_id: terms.vm_id,
  vm_name: "Student research VM",
  owner_account_id: payer,
  owning_bay_id: "bay-1",
  resource_generation: 3,
  funding_epoch: terms.expected_funding_version,
  hourly_usd: "0.25",
  protected_storage_usd: "0.75",
  egress_cap_usd: "0.50",
  storage_delete_at: "2099-10-04T12:00:00Z",
  home_volumes: [],
};

it("normalizes bounded personal terms and rejects implicit or ineligible fallback", () => {
  expect(normalizePersonalVmApprovalTerms(terms)).toMatchObject({
    kind: "personalVMfallback",
    cap_usd: "5.0000000000",
  });
  for (const change of [
    { fallback_reasons: ["course_revoked"] },
    { fallback_reasons: [] },
    { activation: "immediate" },
    { cap_usd: "-5" },
    { cap_usd: "0.001" },
    { expected_funding_version: "" },
    { ends_at: "tomorrow" },
    { kind: "other" },
  ])
    expect(() =>
      normalizePersonalVmApprovalTerms({
        ...terms,
        ...change,
      } as PersonalVmApprovalTerms),
    ).toThrow();
});

it("requires authoritative owner, named resources and generation/epoch in review", () => {
  expect(validatePersonalVmApprovalReview(payer, terms, review)).toEqual(
    review,
  );
  for (const change of [
    { vm_id: randomUUID() },
    { owner_account_id: randomUUID() },
    { vm_name: "" },
    { resource_generation: -1 },
    { resource_generation: 1.5 },
    { funding_epoch: "" },
    { funding_epoch: "different-but-valid-epoch" },
    { hourly_usd: "NaN" },
    { storage_delete_at: "tomorrow" },
    {
      home_volumes: [
        {
          id: randomUUID(),
          name: "unapproved",
          funding_epoch: randomUUID(),
          resource_generation: 1,
          attachment_generation: 1,
          size_gb: 10,
          hourly_usd: "0.01",
          storage_delete_at: review.storage_delete_at,
        },
      ],
    },
  ])
    expect(() =>
      validatePersonalVmApprovalReview(payer, terms, { ...review, ...change }),
    ).toThrow();
});

it("fails closed until the real VM handler is registered and prevents replacement", () => {
  expect(() => getVmPersonalFundingApprovalHandler()).toThrow("not configured");
  const handler = { resolveReview: jest.fn(), apply: jest.fn() };
  const unregister = registerVmPersonalFundingApprovalHandler(handler);
  try {
    expect(getVmPersonalFundingApprovalHandler()).toBe(handler);
    expect(() => registerVmPersonalFundingApprovalHandler(handler)).toThrow(
      "already registered",
    );
  } finally {
    unregister();
  }
  expect(() => getVmPersonalFundingApprovalHandler()).toThrow("not configured");
});
