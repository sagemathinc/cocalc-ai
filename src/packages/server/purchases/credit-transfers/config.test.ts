/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { creditTransfersEnabled } from "./config";

const original = process.env.COCALC_ENABLE_CREDIT_TRANSFERS;

afterEach(() => {
  if (original == null) delete process.env.COCALC_ENABLE_CREDIT_TRANSFERS;
  else process.env.COCALC_ENABLE_CREDIT_TRANSFERS = original;
});

function db(value?: string) {
  return {
    query: jest.fn().mockResolvedValue({
      rows: value == null ? [] : [{ value }],
    }),
  } as any;
}

it("enables transfers by default", async () => {
  delete process.env.COCALC_ENABLE_CREDIT_TRANSFERS;
  expect(await creditTransfersEnabled(db())).toBe(true);
  expect(await creditTransfersEnabled(db("yes"))).toBe(true);
});

it("honors the administrator and environment emergency opt-outs", async () => {
  expect(await creditTransfersEnabled(db("no"))).toBe(false);
  process.env.COCALC_ENABLE_CREDIT_TRANSFERS = "no";
  const database = db("yes");
  expect(await creditTransfersEnabled(database)).toBe(false);
  expect(database.query).not.toHaveBeenCalled();
});
