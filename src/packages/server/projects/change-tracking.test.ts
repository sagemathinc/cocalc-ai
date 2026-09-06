const query = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
}));

import { markProjectBackedUp } from "./change-tracking";

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("information_schema.columns"))
      return {
        rows: [
          { column_name: "last_changed" },
          { column_name: "last_changed_generation" },
          { column_name: "last_backup_generation" },
        ],
      };
    return { rowCount: 1 };
  });
});

it("fences the write by host and capture time without mixing generations from other backups", async () => {
  const time = new Date("2026-09-05T12:00:00Z");
  await markProjectBackedUp({
    host_id: "host",
    project_id: "project",
    backed_up_at: time,
    generation: 23,
  });
  const [sql, params] = query.mock.calls.find(([sql]) =>
    sql.includes("UPDATE projects"),
  )!;
  expect(params).toEqual(["project", time, 23, "host"]);
  expect(sql).toContain("AND host_id = $4");
  expect(sql).toContain("AND deleted IS NOT true");
  expect(sql).toContain("last_backup < $2::TIMESTAMP");
  expect(sql).toContain("last_backup_generation = $3::BIGINT");
  expect(sql).not.toContain("GREATEST");
});

it("clears unknown source generation rather than retaining a different backup's generation", async () => {
  await markProjectBackedUp({
    host_id: "host",
    project_id: "project",
    generation: null,
  });
  const [, params] = query.mock.calls.find(([sql]) =>
    sql.includes("UPDATE projects"),
  )!;
  expect(params[2]).toBeNull();
});

it.each([-1, 1.5, 2 ** 53, NaN, Infinity])(
  "rejects malformed generation %s before reporting success",
  async (generation) => {
    await expect(
      markProjectBackedUp({
        host_id: "host",
        project_id: "project",
        generation,
      }),
    ).rejects.toThrow("invalid project generation");
    expect(
      query.mock.calls.some(([sql]) => sql.includes("UPDATE projects")),
    ).toBe(false);
  },
);

it("does not turn malformed timestamps into successful current backups", async () => {
  await expect(
    markProjectBackedUp({
      host_id: "host",
      project_id: "project",
      backed_up_at: "invalid",
    }),
  ).rejects.toThrow("invalid project change time");
  expect(
    query.mock.calls.some(([sql]) => sql.includes("UPDATE projects")),
  ).toBe(false);
});
