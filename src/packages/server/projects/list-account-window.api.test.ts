import getPool from "@cocalc/database/pool";
import { listProjectSummaries } from "./list-account-window";
import { admitAccountSearch } from "@cocalc/server/api/search-admission";

jest.mock("@cocalc/server/api/search-admission", () => ({
  admitAccountSearch: jest.fn(),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const account_id = "11111111-1111-4111-8111-111111111111";
const project_id = "22222222-2222-4222-8222-222222222222";
const release = jest.fn();
const query = jest.fn();

beforeEach(() => {
  jest.mocked(admitAccountSearch).mockReset().mockResolvedValue(undefined);
  release.mockClear();
  query.mockReset();
  jest.mocked(getPool).mockClear();
  jest.mocked(getPool).mockReturnValue({
    connect: async () => ({ query, release }),
  } as any);
  query.mockImplementation(async (sql) =>
    String(sql).includes("SELECT project_id")
      ? {
          rows: [
            {
              project_id: "22222222-2222-4222-8222-222222222222",
              title: "SageMath",
              description: "Worksheets",
              host_id: null,
              state: "running",
              last_edited: "2026-09-25T00:00:00Z",
              users_summary: { private: "must never be returned" },
              labels: { secret: "must never be returned" },
            },
          ],
        }
      : { rows: [] },
  );
});

test("returns only the declared summary fields and searches only those fields", async () => {
  const result = await listProjectSummaries({
    account_id,
    search: "Sage",
  });
  expect(result).toEqual({
    projects: [
      {
        project_id: "22222222-2222-4222-8222-222222222222",
        title: "SageMath",
        description: "Worksheets",
        host_id: null,
        state: "running",
        last_edited: "2026-09-25T00:00:00.000Z",
      },
    ],
    next_offset: null,
  });
  const sql = String(
    query.mock.calls.find(([statement]) =>
      String(statement).includes("SELECT project_id"),
    )?.[0],
  );
  expect(sql).toContain("title");
  expect(sql).toContain("description");
  expect(sql).not.toContain("labels");
  expect(sql).not.toContain("users_summary");
  expect(query).toHaveBeenCalledWith("SET LOCAL statement_timeout = '5s'");
  expect(release).toHaveBeenCalledTimes(1);
});

test("rejects over-limit inputs before accessing the database", async () => {
  await expect(
    listProjectSummaries({ account_id, limit: 501 }),
  ).rejects.toThrow(/limit/);
  await expect(
    listProjectSummaries({ account_id, search: "a".repeat(201) }),
  ).rejects.toThrow(/search/);
  await expect(
    listProjectSummaries({ account_id, project_id: "not-a-uuid" }),
  ).rejects.toThrow(/project id/);
  expect(getPool).not.toHaveBeenCalled();
  expect(admitAccountSearch).not.toHaveBeenCalled();
});

test("rejects account admission before allocating a summary query", async () => {
  jest
    .mocked(admitAccountSearch)
    .mockRejectedValue(new Error("account search rate exceeded"));
  await expect(listProjectSummaries({ account_id })).rejects.toThrow(
    "account search rate exceeded",
  );
  expect(admitAccountSearch).toHaveBeenCalledWith(account_id);
  expect(getPool).not.toHaveBeenCalled();
});

test("exact project lookup stays inside the caller account index", async () => {
  await listProjectSummaries({ account_id, project_id, limit: 1 });
  const select = query.mock.calls.find(([statement]) =>
    String(statement).includes("SELECT project_id"),
  );
  expect(String(select?.[0])).toContain("account_id=$1::UUID");
  expect(String(select?.[0])).toContain("project_id=$2::UUID");
  expect(select?.[1]).toEqual([account_id, project_id, 2, 0]);
});

test("bounds the whole UTF-8 page including its envelope and continuation", async () => {
  const maxBytes = 2 * 1024 * 1024;
  const row = {
    project_id,
    title: "",
    description: "",
    host_id: null,
    state: "running",
    last_edited: null,
  };
  const descriptionBytes =
    Math.floor(maxBytes / 500) - Buffer.byteLength(JSON.stringify(row), "utf8");
  const twoByteCharacters = descriptionBytes - 2048;
  expect(twoByteCharacters).toBeGreaterThan(0);
  expect(twoByteCharacters).toBeLessThan(2048);
  row.description =
    "\u00e9".repeat(twoByteCharacters) + "a".repeat(2048 - twoByteCharacters);
  const rows = Array.from({ length: 500 }, (_, i) => ({
    ...row,
    project_id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
  }));
  query.mockImplementation(async (sql, params) =>
    String(sql).includes("SELECT project_id")
      ? { rows: rows.slice(params.at(-1), params.at(-1) + params.at(-2)) }
      : { rows: [] },
  );
  const first = await listProjectSummaries({ account_id, limit: 500 });
  expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(
    maxBytes,
  );
  expect(first.projects).toHaveLength(499);
  expect(first.next_offset).toBe(499);
  const next = await listProjectSummaries({
    account_id,
    limit: 500,
    offset: first.next_offset!,
  });
  expect(next.projects).toEqual(rows.slice(499));
  expect(next.next_offset).toBeNull();
  expect([...first.projects, ...next.projects]).toEqual(rows);
});

test("rejects an oversized summary instead of returning a nonadvancing page", async () => {
  query.mockImplementation(async (sql) =>
    String(sql).includes("SELECT project_id")
      ? {
          rows: [
            {
              project_id,
              title: "",
              description: "",
              host_id: null,
              state: "x".repeat(2 * 1024 * 1024),
              last_edited: null,
            },
          ],
        }
      : { rows: [] },
  );
  await expect(listProjectSummaries({ account_id })).rejects.toThrow(
    "project summary exceeds page byte budget",
  );
  expect(release).toHaveBeenCalledTimes(1);
});
