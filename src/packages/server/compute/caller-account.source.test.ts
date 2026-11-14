/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every managed-compute entry point takes its actor from
// computeCallerAccountId, which refuses a call naming both an account and an
// agent credential. Reading agent_auth.account_id directly would bypass that.
describe("managed-compute actor resolution", () => {
  for (const file of [
    "conat/api/compute.ts",
    "compute/owner-resource-mutation.ts",
    "compute/volume-placement.ts",
  ]) {
    it(`${file} resolves the actor only through computeCallerAccountId`, () => {
      const source = readFileSync(join(__dirname, "..", file), "utf8");
      expect(source).not.toMatch(/agent_auth\?\.account_id\s*\?\?/);
      expect(source).toContain("computeCallerAccountId(");
    });
  }
});
