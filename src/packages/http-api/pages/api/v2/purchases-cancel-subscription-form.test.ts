/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { AddressInfo } from "node:net";

import express from "express";

const mockExecuteBillingHttpCommand = jest.fn();
const mockRequireFreshAuth = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: jest.fn(async () => "account-1"),
}));
jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  requireFreshAuth: (...args: unknown[]) => mockRequireFreshAuth(...args),
}));
jest.mock("@cocalc/server/purchases/billing-authority/client", () => ({
  billingAuthorityErrorAttrs: () => ({}),
  executeBillingHttpCommand: (...args: unknown[]) =>
    mockExecuteBillingHttpCommand(...args),
}));

import handler from "./purchases/cancel-subscription";

describe("form-encoded subscription cancellation", () => {
  beforeEach(() => {
    mockExecuteBillingHttpCommand.mockReset().mockResolvedValue(undefined);
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
  });

  it("normalizes a canonical decimal subscription id", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.post("/purchases/cancel-subscription", handler);
    const server = await new Promise<ReturnType<typeof app.listen>>(
      (resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      },
    );

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/purchases/cancel-subscription`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "subscription_id=7&reason=user-request",
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
      expect(mockExecuteBillingHttpCommand).toHaveBeenCalledWith(
        "cancel-subscription",
        {
          account_id: "account-1",
          subscription_id: 7,
          reason: "user-request",
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
