/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { validate_client_query } from "./schema-validate";

describe("validate_client_query projects set queries", () => {
  const accountId = "00000000-0000-4000-8000-000000000000";

  test("projects_all title-only set query validates", () => {
    const query = {
      projects_all: {
        project_id: "5e9911c5-67f3-48be-b123-2eead7f64579",
        title: "Project XXX",
      },
    };
    expect(validate_client_query(query, accountId)).toBeUndefined();
  });

  test("projects manage_users_owner_only requires boolean", () => {
    const query = {
      projects: {
        project_id: "4a9655b8-ed54-46b8-a453-e0ba5fd94936",
        manage_users_owner_only: "yes" as any,
      },
    };
    expect(() => validate_client_query(query, accountId)).toThrow(
      "manage_users_owner_only must be a boolean",
    );
  });
});
