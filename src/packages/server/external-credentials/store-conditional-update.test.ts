/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { EXTERNAL_CREDENTIAL_CONFLICT } from "@cocalc/util/external-credential-conflict";
import { updateExternalCredentialById } from "./store";

// Stored payload as the fake database holds it (encryption is the identity).
let storedPayload = "bundle-1";
const queries: string[] = [];
const mockQuery = jest.fn(async (text: string, values?: unknown[]) => {
  const sql = text.replace(/\s+/g, " ").trim();
  queries.push(
    sql.startsWith("SELECT encrypted_payload") ? "READ" : sql.split(" ")[0],
  );
  if (sql.startsWith("SELECT encrypted_payload"))
    return { rows: [{ encrypted_payload: storedPayload }], rowCount: 1 };
  if (sql.startsWith("UPDATE external_credentials")) {
    storedPayload = `${values?.[7]}`;
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    connect: async () => ({ query: mockQuery, release: () => {} }),
    query: mockQuery,
  }),
}));
jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, value: string) => value,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value,
  }),
}));

const selector = {
  provider: "anthropic",
  kind: "claude-subscription",
  scope: "account" as const,
  owner_account_id: "00000000-0000-4000-8000-000000000002",
};
const id = "00000000-0000-4000-8000-000000000003";
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

beforeEach(() => {
  storedPayload = "bundle-1";
  queries.length = 0;
});

test("a matching expected hash updates under the selector lock", async () => {
  await expect(
    updateExternalCredentialById({
      id,
      selector,
      payload: "bundle-2",
      metadata: {},
      expectedPayloadSha256: sha256("bundle-1"),
    }),
  ).resolves.toBe(true);
  expect(storedPayload).toBe("bundle-2");
  // The stored payload is read after the lock and before the update.
  expect(queries.indexOf("READ")).toBeGreaterThan(queries.indexOf("SELECT"));
  expect(queries.indexOf("READ")).toBeLessThan(queries.indexOf("UPDATE"));
  expect(queries.at(-1)).toBe("COMMIT");
});

test("a stale expected hash conflicts without updating", async () => {
  await expect(
    updateExternalCredentialById({
      id,
      selector,
      payload: "stale",
      metadata: {},
      expectedPayloadSha256: sha256("bundle-0"),
    }),
  ).rejects.toThrow(EXTERNAL_CREDENTIAL_CONFLICT);
  expect(storedPayload).toBe("bundle-1");
  expect(queries).not.toContain("UPDATE");
  expect(queries).toContain("ROLLBACK");
});

test("a malformed expected hash is rejected before touching the database", async () => {
  await expect(
    updateExternalCredentialById({
      id,
      selector,
      payload: "x",
      metadata: {},
      expectedPayloadSha256: "not-a-hash",
    }),
  ).rejects.toThrow("invalid expected payload hash");
  expect(queries).toEqual([]);
});

test("without an expectation the update stays unconditional", async () => {
  await expect(
    updateExternalCredentialById({
      id,
      selector,
      payload: "bundle-2",
      metadata: {},
    }),
  ).resolves.toBe(true);
  expect(queries).not.toContain("READ");
  expect(storedPayload).toBe("bundle-2");
});
