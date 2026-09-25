import getPool from "@cocalc/database/pool";
import { listProjectSummaries } from "./list-account-window";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const account_id = "11111111-1111-4111-8111-111111111111";
const release = jest.fn();
const query = jest.fn();

beforeEach(() => {
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
  expect(getPool).not.toHaveBeenCalled();
});
