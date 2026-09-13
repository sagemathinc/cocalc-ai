/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  assertBillingAuthorityAccountRegistered,
  assertStripeMutationAuthorized,
  beginStripeMutation,
  enableStripeMutationAuthorityEnforcement,
  finishStripeMutation,
  getBillingAuthorityContext,
  isInBillingAuthorityContext,
  registerBillingAuthorityAccount,
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

  it("keeps caller-keyed Stripe mutations stable when replay order changes", async () => {
    let originalKey = "";
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "stable-command-id",
      fn: async () => {
        const precedingKey = await beginStripeMutation({
          method: "POST",
          path: "/v1/customers",
          body: "metadata[first]=true",
          existing_key: "create-customer",
        });
        finishStripeMutation({ key: precedingKey, status: 200 });
        originalKey = await beginStripeMutation({
          method: "POST",
          path: "/v1/invoices",
          body: "customer=cus_1",
          existing_key: "create-package-invoice",
        });
      },
    });

    let replayKey = "";
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "stable-command-id",
      fn: async () => {
        replayKey = await beginStripeMutation({
          method: "POST",
          path: "/v1/invoices",
          body: "customer=cus_1&unexpected=change",
          existing_key: "create-package-invoice",
        });
      },
    });

    expect(replayKey).toBe(originalKey);
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "different-command-id",
      fn: async () => {
        await expect(
          beginStripeMutation({
            method: "POST",
            path: "/v1/invoices",
            body: "customer=cus_1",
            existing_key: "create-package-invoice",
          }),
        ).resolves.not.toBe(originalKey);
      },
    });
  });

  it("records the provider boundary once before issuing mutation keys", async () => {
    const recordProviderStart = jest.fn(async () => undefined);
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "provider-boundary",
      record_provider_start: recordProviderStart,
      fn: async () => {
        await beginStripeMutation({
          method: "POST",
          path: "/v1/customers",
          body: "name=first",
          existing_key: "first",
        });
        await beginStripeMutation({
          method: "POST",
          path: "/v1/invoices",
          body: "customer=cus_1",
          existing_key: "second",
        });
      },
    });
    expect(recordProviderStart).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an enabled authority omits provider journaling", async () => {
    const previous = process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
    try {
      await expect(
        runInBillingAuthorityContext({
          operation: "test",
          request_id: "missing-provider-journal",
          fn: async () =>
            await beginStripeMutation({
              method: "POST",
              path: "/v1/invoices",
              body: "customer=cus_1",
            }),
        }),
      ).rejects.toThrow("provider journal is unavailable");
    } finally {
      if (previous == null) {
        delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
      } else {
        process.env.COCALC_BILLING_AUTHORITY_ENABLED = previous;
      }
    }
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

  it("registers each dynamically resolved account once per command", async () => {
    const registerAccount = jest.fn(async () => undefined);
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "request-dynamic-account",
      register_account: registerAccount,
      fn: async () => {
        await registerBillingAuthorityAccount(
          "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        );
        await registerBillingAuthorityAccount(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        );
        await expect(
          assertBillingAuthorityAccountRegistered(
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
          ),
        ).resolves.toBeUndefined();
      },
    });
    expect(registerAccount).toHaveBeenCalledTimes(1);
    expect(registerAccount).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  it("rejects account registration after the authority context expires", async () => {
    let authorityActive = true;
    const registerAccount = jest.fn();
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "request-expired-registration",
      authority_active: () => authorityActive,
      register_account: registerAccount,
      fn: async () => {
        authorityActive = false;
        await expect(
          registerBillingAuthorityAccount(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          ),
        ).rejects.toMatchObject({ code: 503, status: 503 });
      },
    });
    expect(registerAccount).not.toHaveBeenCalled();
  });

  it("rejects direct financial writes after authority activation", async () => {
    const previous = process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    process.env.COCALC_BILLING_AUTHORITY_ENABLED = "true";
    try {
      await expect(
        registerBillingAuthorityAccount("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      ).rejects.toMatchObject({ code: 503, status: 503 });
      await expect(
        registerBillingAuthorityAccount(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          { allow_direct_execution: true },
        ),
      ).resolves.toBeUndefined();
      await expect(
        assertBillingAuthorityAccountRegistered(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
      ).rejects.toMatchObject({ code: 503, status: 503 });
      await expect(
        assertBillingAuthorityAccountRegistered(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          { allow_direct_execution: true },
        ),
      ).resolves.toBeUndefined();
    } finally {
      if (previous == null) {
        delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
      } else {
        process.env.COCALC_BILLING_AUTHORITY_ENABLED = previous;
      }
    }
  });

  it("fails closed when a ledger account was never fenced", async () => {
    await runInBillingAuthorityContext({
      operation: "test",
      request_id: "request-ledger-fence",
      pre_registered_accounts: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
      fn: async () => {
        await expect(
          assertBillingAuthorityAccountRegistered(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          ),
        ).resolves.toBeUndefined();
        await expect(
          assertBillingAuthorityAccountRegistered(
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          ),
        ).rejects.toMatchObject({ code: 503, status: 503 });
      },
    });
  });
});
