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
    expect(stripeMutationEnforcementDefault("production", true)).toBe(true);
    expect(stripeMutationEnforcementDefault("development", true)).toBe(true);
    expect(stripeMutationEnforcementDefault(undefined, true)).toBe(true);
    expect(stripeMutationEnforcementDefault("test", true)).toBe(false);
    expect(stripeMutationEnforcementDefault("production", false)).toBe(false);
  });

  it("allows legacy callers until enforcement is enabled", async () => {
    await expect(
      assertStripeMutationAuthorized({ method: "POST", path: "/v1/invoices" }),
    ).resolves.toBeUndefined();
  });

  it("rejects Stripe mutations outside the authority", async () => {
    enableStripeMutationAuthorityEnforcement();
    await expect(
      assertStripeMutationAuthorized({ method: "POST", path: "/v1/invoices" }),
    ).rejects.toThrow("must run through the billing authority");
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
        await expect(
          assertStripeMutationAuthorized({
            method: "DELETE",
            path: "/v1/payment_methods/pm_1",
          }),
        ).resolves.toBeUndefined();
      },
    });
    expect(isInBillingAuthorityContext()).toBe(false);
    await expect(
      assertStripeMutationAuthorized({ method: "POST", path: "/v1/invoices" }),
    ).rejects.toThrow();
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
          await expect(
            assertStripeMutationAuthorized({
              method: "POST",
              path: "/v1/payment_intents",
            }),
          ).rejects.toThrow("must run through the billing authority");
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
        await expect(
          assertStripeMutationAuthorized({
            method: "POST",
            path: "/v1/invoices",
          }),
        ).rejects.toThrow("must run through the billing authority");
      },
    });
  });
});
