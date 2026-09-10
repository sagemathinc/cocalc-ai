/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { SCHEMA } from "./types";
import "./account-managed-egress";

describe("managed egress rollup indexes", () => {
  it("indexes recent account events in the query's complete sort order", () => {
    expect(SCHEMA.account_managed_egress_rollups.pg_custom_indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "account_managed_egress_rollups_account_recent_idx",
          query: "(account_id, last_occurred_at DESC, bucket_start DESC)",
        }),
      ]),
    );
  });
});
