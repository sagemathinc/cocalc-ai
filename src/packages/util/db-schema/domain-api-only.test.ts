/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { DOMAIN_API_ONLY_USER_QUERY_MUTATION_TABLES, SCHEMA } from "./index";

describe("domain API only user-query tables", () => {
  it("does not expose generic mutations", () => {
    for (const table of DOMAIN_API_ONLY_USER_QUERY_MUTATION_TABLES) {
      expect(SCHEMA[table]).toBeDefined();
      expect(SCHEMA[table].user_query?.set).toBeUndefined();
      expect(SCHEMA[table].project_query?.set).toBeUndefined();
    }
  });
});
