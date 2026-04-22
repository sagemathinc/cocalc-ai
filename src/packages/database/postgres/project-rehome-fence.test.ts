/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { assertProjectNotRehoming } from "./project-rehome-fence";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

describe("project rehome fence", () => {
  it("takes the project advisory lock and allows writes before the operations table exists", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: null }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });

    await assertProjectNotRehoming({
      db: { query },
      project_id: PROJECT_ID,
      action: "set project settings",
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[0][1]).toEqual(["project-rehome", PROJECT_ID]);
    expect(query.mock.calls[1][0]).toContain("to_regclass");
  });

  it("rejects writes while a running rehome exists", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: "project_rehome_operations" }] };
      }
      if (sql.includes("FROM project_rehome_operations")) {
        return {
          rows: [
            {
              op_id: "op-1",
              source_bay_id: "bay-0",
              dest_bay_id: "bay-2",
              stage: "copy_project_log",
            },
          ],
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });

    await expect(
      assertProjectNotRehoming({
        db: { query },
        project_id: PROJECT_ID,
        action: "set project settings",
      }),
    ).rejects.toThrow(
      `cannot set project settings for project ${PROJECT_ID}; project rehome op-1 is running from bay-0 to bay-2 at stage copy_project_log`,
    );

    expect(query).toHaveBeenCalledTimes(3);
  });
});
