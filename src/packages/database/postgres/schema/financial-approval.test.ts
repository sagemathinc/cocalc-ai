/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { PglitePool } from "@cocalc/database/pool/pglite";
import { SCHEMA } from "@cocalc/util/db-schema";
import { schemaNeedsSync, syncSchema } from "./sync";

let db: PglitePool;
jest.mock("@cocalc/database/pool", () => ({
  ...jest.requireActual("@cocalc/database/pool"),
  getClient: () => ({
    connect: async () => {},
    end: async () => {},
    query: (...args) => db.query(...args),
  }),
}));

const schema = Object.fromEntries(
  ["financial_approval_identities", "financial_approval_sessions"].map(
    (name) => [name, SCHEMA[name]],
  ),
);
const account = "11111111-1111-4111-8111-111111111111";
const intent = "22222222-2222-4222-8222-222222222222";
let previousBackend: string | undefined;

beforeEach(() => {
  previousBackend = process.env.COCALC_DB;
  process.env.COCALC_DB = "pglite";
  db = new PglitePool();
});
afterEach(async () => {
  await db.end();
  if (previousBackend === undefined) delete process.env.COCALC_DB;
  else process.env.COCALC_DB = previousBackend;
});

it("creates and converges approval identity/session tables through normal schema sync", async () => {
  expect(await schemaNeedsSync(schema)).toBe(true);
  await syncSchema(schema);
  await db.query(
    "INSERT INTO financial_approval_identities(account_id,email_address) VALUES($1,$2)",
    [account, "payer@example.test"],
  );
  await syncSchema(schema);
  expect(await schemaNeedsSync(schema)).toBe(false);
  const { rows } = await db.query(
    "SELECT email_address,generation,updated_at IS NOT NULL AS dated FROM financial_approval_identities",
  );
  expect(rows).toEqual([
    { email_address: "payer@example.test", generation: "1", dated: true },
  ]);
});

it("upgrades legacy approval sessions without losing rows or granting identity verification", async () => {
  await db.query(`CREATE TABLE financial_approval_sessions (
    session_hash TEXT PRIMARY KEY,
    account_id UUID NOT NULL,
    approval_origin TEXT NOT NULL,
    primary_auth_method TEXT NOT NULL,
    primary_verified_at TIMESTAMPTZ NOT NULL,
    factor_level TEXT NOT NULL,
    factor_verified_at TIMESTAMPTZ,
    authenticated_for_intent_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expire TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
  )`);
  await db.query(
    `INSERT INTO financial_approval_sessions
     (session_hash,account_id,approval_origin,primary_auth_method,
      primary_verified_at,factor_level,authenticated_for_intent_id,expire,revoked_at)
     VALUES ('legacy',$1,'https://approve.example.test','email_code',now(),
             'none',$2,now() + interval '1 hour',now())`,
    [account, intent],
  );
  expect(await schemaNeedsSync(schema)).toBe(true);
  await syncSchema(schema);
  await syncSchema(schema);
  expect(await schemaNeedsSync(schema)).toBe(false);
  const { rows } = await db.query(
    `SELECT session_hash,account_id,authenticated_for_intent_id,
            email_address,identity_generation,revoked_at IS NOT NULL AS revoked
       FROM financial_approval_sessions`,
  );
  expect(rows).toEqual([
    {
      session_hash: "legacy",
      account_id: account,
      authenticated_for_intent_id: intent,
      email_address: null,
      identity_generation: null,
      revoked: true,
    },
  ]);
});
