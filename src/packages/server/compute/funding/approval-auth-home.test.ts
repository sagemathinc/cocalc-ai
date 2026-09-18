/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";
import {
  finishSignInPasskeyAuthentication,
  startSignInPasskeyAuthentication,
} from "@cocalc/server/auth/passkeys";
import {
  createSignInSecondFactorChallenge,
  hasActiveSecondFactor,
  verifySignInSecondFactorChallenge,
} from "@cocalc/server/auth/two-factor";
import { financialApprovalAuthOnHome } from "./approval-auth-home";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/auth/passkeys", () => ({
  finishSignInPasskeyAuthentication: jest.fn(),
  startSignInPasskeyAuthentication: jest.fn(),
}));
jest.mock("@cocalc/server/auth/two-factor", () => ({
  createSignInSecondFactorChallenge: jest.fn(),
  hasActiveSecondFactor: jest.fn(),
  verifySignInSecondFactorChallenge: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-home"),
}));

const account_id = randomUUID();
const intent_id = randomUUID();
const challenge_id = randomUUID();
const approval_origin = "https://approve.example.test";
const email_address = "payer@example.test";
const primary_verified_at = new Date().toISOString();
const query = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (getPool as jest.Mock).mockReturnValue({ query });
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM accounts")) {
      return { rows: [{ exists: 1 }] };
    }
    return { rows: [] };
  });
});

it("returns ready after primary authentication when no second factor is active", async () => {
  (hasActiveSecondFactor as jest.Mock).mockResolvedValue(false);
  await expect(
    financialApprovalAuthOnHome({
      action: "begin",
      account_id,
      email_address,
      approval_origin,
      intent_id,
      primary_auth_method: "email_code",
      primary_verified_at,
    }),
  ).resolves.toMatchObject({
    state: "ready",
    account_id,
    primary_auth_method: "email_code",
    factor_level: "none",
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("lower(email_address)=$2"),
    [account_id, email_address, "bay-home"],
  );
});

it("creates an intent-bound challenge using the account's actual methods", async () => {
  (hasActiveSecondFactor as jest.Mock).mockResolvedValue(true);
  (createSignInSecondFactorChallenge as jest.Mock).mockResolvedValue({
    challenge_id,
    methods: ["passkey", "totp", "recovery_code"],
  });
  await expect(
    financialApprovalAuthOnHome({
      action: "begin",
      account_id,
      email_address,
      approval_origin,
      intent_id,
      primary_auth_method: "password",
      primary_verified_at,
    }),
  ).resolves.toEqual({
    state: "second_factor",
    account_id,
    challenge_id,
    methods: ["passkey", "totp", "recovery_code"],
  });
  expect(createSignInSecondFactorChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id,
      metadata: {
        financial_approval_origin: approval_origin,
        financial_intent_id: intent_id,
        financial_approval_email: email_address,
      },
    }),
  );
});

it("rejects a challenge bound to another intent before factor verification", async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM accounts")) {
      return { rows: [{ exists: 1 }] };
    }
    return {
      rows: [
        {
          account_id,
          metadata: {
            financial_approval_origin: approval_origin,
            financial_intent_id: randomUUID(),
            financial_approval_email: email_address,
          },
        },
      ],
    };
  });
  await expect(
    financialApprovalAuthOnHome({
      action: "verify-code",
      account_id,
      email_address,
      approval_origin,
      intent_id,
      challenge_id,
      method: "totp",
      code: "123456",
    }),
  ).rejects.toThrow("challenge mismatch");
  expect(verifySignInSecondFactorChallenge).not.toHaveBeenCalled();
});

it("rejects a challenge bound to another email before factor verification", async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM accounts")) {
      return { rows: [{ exists: 1 }] };
    }
    return {
      rows: [
        {
          account_id,
          metadata: {
            financial_approval_origin: approval_origin,
            financial_intent_id: intent_id,
            financial_approval_email: "old@example.test",
          },
        },
      ],
    };
  });

  await expect(
    financialApprovalAuthOnHome({
      action: "verify-code",
      account_id,
      email_address,
      approval_origin,
      intent_id,
      challenge_id,
      method: "totp",
      code: "123456",
    }),
  ).rejects.toThrow("challenge mismatch");
  expect(verifySignInSecondFactorChallenge).not.toHaveBeenCalled();
});

it("uses the isolated origin and parent RP ID for passkey verification", async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM accounts")) {
      return { rows: [{ exists: 1 }] };
    }
    return {
      rows: [
        {
          account_id,
          metadata: {
            financial_approval_origin: approval_origin,
            financial_intent_id: intent_id,
            financial_approval_email: email_address,
          },
        },
      ],
    };
  });
  (startSignInPasskeyAuthentication as jest.Mock).mockResolvedValue({
    challenge_id,
    options: { challenge: "challenge" },
  });
  await expect(
    financialApprovalAuthOnHome({
      action: "start-passkey",
      account_id,
      email_address,
      approval_origin,
      intent_id,
      challenge_id,
      relying_party: {
        origin: approval_origin,
        rp_id: "example.test",
        rp_name: "CoCalc",
      },
    }),
  ).resolves.toMatchObject({ state: "passkey", challenge_id });
  expect(startSignInPasskeyAuthentication).toHaveBeenCalledWith({
    challenge_id,
    relying_party: {
      origin: approval_origin,
      rp_id: "example.test",
      rp_name: "CoCalc",
    },
  });
  expect(finishSignInPasskeyAuthentication).not.toHaveBeenCalled();
});

it("binds related-origin passkeys to the challenged approval origin", async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM accounts")) {
      return { rows: [{ exists: 1 }] };
    }
    return {
      rows: [
        {
          account_id,
          metadata: {
            financial_approval_origin: approval_origin,
            financial_intent_id: intent_id,
            financial_approval_email: email_address,
          },
        },
      ],
    };
  });
  await expect(
    financialApprovalAuthOnHome({
      action: "start-passkey",
      account_id,
      email_address,
      approval_origin,
      intent_id,
      challenge_id,
      relying_party: {
        origin: "https://attacker.example.test",
        rp_id: "example.test",
        rp_name: "CoCalc",
        allow_related_origin: true,
      },
    }),
  ).rejects.toThrow("passkey origin mismatch");
  expect(startSignInPasskeyAuthentication).not.toHaveBeenCalled();
});

it("rejects an obsolete email before issuing a financial challenge", async () => {
  query.mockResolvedValue({ rows: [] });

  await expect(
    financialApprovalAuthOnHome({
      action: "begin",
      account_id,
      email_address: "old@example.test",
      approval_origin,
      intent_id,
      primary_auth_method: "email_code",
      primary_verified_at,
    }),
  ).rejects.toThrow("identity mismatch");
  expect(hasActiveSecondFactor).not.toHaveBeenCalled();
});
