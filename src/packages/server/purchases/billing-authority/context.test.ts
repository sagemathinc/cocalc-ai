/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  assertStripeMutationAuthorized,
  enableStripeMutationAuthorityEnforcement,
  getBillingAuthorityContext,
  isInBillingAuthorityContext,
  resetBillingAuthorityContextForTests,
  runInBillingAuthorityContext,
  stripeMutationEnforcementDefault,
} from "./context";

describe("billing authority context", () => {
  beforeEach(resetBillingAuthorityContextForTests);
  afterEach(resetBillingAuthorityContextForTests);

  it("enforces Stripe authority by default outside tests", () => {
    expect(stripeMutationEnforcementDefault("production")).toBe(true);
    expect(stripeMutationEnforcementDefault("development")).toBe(true);
    expect(stripeMutationEnforcementDefault(undefined)).toBe(true);
    expect(stripeMutationEnforcementDefault("test")).toBe(false);
  });

  it("allows legacy callers until enforcement is enabled", () => {
    expect(() =>
      assertStripeMutationAuthorized({ method: "POST", path: "/v1/invoices" }),
    ).not.toThrow();
  });

  it("rejects Stripe mutations outside the authority", () => {
    enableStripeMutationAuthorityEnforcement();
    expect(() =>
      assertStripeMutationAuthorized({ method: "POST", path: "/v1/invoices" }),
    ).toThrow("must run through the billing authority");
  });

  it("authorizes only the asynchronous authority execution chain", async () => {
    enableStripeMutationAuthorityEnforcement();
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "request-1",
      fn: async () => {
        expect(isInBillingAuthorityContext()).toBe(true);
        expect(getBillingAuthorityContext()).toEqual({
          operation: "test",
          request_id: "request-1",
        });
        await Promise.resolve();
        expect(() =>
          assertStripeMutationAuthorized({
            method: "DELETE",
            path: "/v1/payment_methods/pm_1",
          }),
        ).not.toThrow();
      },
    });
    expect(isInBillingAuthorityContext()).toBe(false);
    expect(() =>
      assertStripeMutationAuthorized({ method: "POST", path: "/v1/invoices" }),
    ).toThrow();
  });

  it("expires authority inherited by detached asynchronous work", async () => {
    enableStripeMutationAuthorityEnforcement();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let detached!: Promise<boolean>;

    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "request-detached",
      fn: async () => {
        detached = (async () => {
          await gate;
          expect(isInBillingAuthorityContext()).toBe(false);
          expect(getBillingAuthorityContext()).toBeUndefined();
          expect(() =>
            assertStripeMutationAuthorized({
              method: "POST",
              path: "/v1/payment_intents",
            }),
          ).toThrow("must run through the billing authority");
          return true;
        })();
      },
    });

    release();
    await expect(detached).resolves.toBe(true);
  });

  it("revokes authority immediately when its election lease is lost", async () => {
    enableStripeMutationAuthorityEnforcement();
    let authorityActive = true;
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "request-revoked",
      authority_active: () => authorityActive,
      fn: async () => {
        expect(isInBillingAuthorityContext()).toBe(true);
        authorityActive = false;
        expect(isInBillingAuthorityContext()).toBe(false);
        expect(() =>
          assertStripeMutationAuthorized({
            method: "POST",
            path: "/v1/invoices",
          }),
        ).toThrow("must run through the billing authority");
      },
    });
  });
});
