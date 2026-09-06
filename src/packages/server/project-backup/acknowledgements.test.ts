const query = jest.fn();
const release = jest.fn();
const connect = jest.fn(async () => ({ query, release }));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query, connect }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  assertAccountNotRehoming: jest.fn(),
  assertAccountWriteOnHomeBay: jest.fn(),
}));
import { backupAcknowledgementsLocal } from "./acknowledgements";
const account_id = "00000000-0000-4000-8000-000000000001";
const project_id = "00000000-0000-4000-8000-000000000002";
const key = "a".repeat(64);
let count: string;
let present: boolean;
let owned: boolean;
beforeEach(() => {
  jest.clearAllMocks();
  count = "0";
  present = false;
  owned = true;
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT account_id FROM accounts"))
      return { rows: owned ? [{ account_id }] : [] };
    if (sql.includes("COUNT(*)")) return { rows: [{ count, present }] };
    if (sql.includes("SELECT key FROM")) return { rows: [{ key }] };
    return { rows: [] };
  });
});
it("locks the home account before bounded insertion and scopes reads by account and project", async () => {
  await expect(
    backupAcknowledgementsLocal({ account_id, project_id, key }),
  ).resolves.toEqual([key]);
  const calls = query.mock.calls;
  expect(calls.find(([sql]) => sql.includes("FOR UPDATE"))![1]).toEqual([
    account_id,
    "bay-0",
  ]);
  expect(calls.find(([sql]) => sql.includes("INSERT INTO"))![1]).toEqual([
    account_id,
    project_id,
    key,
    "version",
  ]);
  expect(calls.find(([sql]) => sql.includes("SELECT key FROM"))![1]).toEqual([
    account_id,
    project_id,
    10001,
    "version",
  ]);
  expect(query).toHaveBeenCalledWith("COMMIT");
  expect(release).toHaveBeenCalled();
});
it("keeps path preferences separate from version preferences and allows revocation at capacity", async () => {
  await backupAcknowledgementsLocal({
    account_id,
    project_id,
    key,
    scope: "path",
  });
  expect(
    query.mock.calls.find(([sql]) => sql.includes("INSERT INTO"))![1],
  ).toEqual([account_id, project_id, key, "path"]);
  expect(
    query.mock.calls.find(([sql]) => sql.includes("SELECT key FROM"))![1],
  ).toEqual([account_id, project_id, 10001, "path"]);
  jest.clearAllMocks();
  count = "10000";
  await backupAcknowledgementsLocal({
    account_id,
    project_id,
    key,
    scope: "path",
    remove: true,
  });
  expect(
    query.mock.calls.find(([sql]) => sql.includes("DELETE FROM"))![1],
  ).toEqual([account_id, project_id, key, "path"]);
  expect(
    query.mock.calls.some(
      ([sql]) => sql.includes("INSERT INTO") || sql.includes("COUNT(*)"),
    ),
  ).toBe(false);
});
it("rejects invalid scopes and unkeyed removals before database access", async () => {
  await expect(
    backupAcknowledgementsLocal({
      account_id,
      project_id,
      scope: "all" as any,
    }),
  ).rejects.toThrow("scope");
  await expect(
    backupAcknowledgementsLocal({ account_id, project_id, remove: true }),
  ).rejects.toThrow("key");
  expect(connect).not.toHaveBeenCalled();
});
it("rejects a new key at capacity but permits idempotent acknowledgement", async () => {
  count = "10000";
  await expect(
    backupAcknowledgementsLocal({ account_id, project_id, key }),
  ).rejects.toThrow("limit reached");
  expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(
    false,
  );
  expect(query).toHaveBeenCalledWith("ROLLBACK");
  present = true;
  await expect(
    backupAcknowledgementsLocal({ account_id, project_id, key }),
  ).resolves.toEqual([key]);
});
it("rejects wrong home bay without touching preferences", async () => {
  owned = false;
  await expect(
    backupAcknowledgementsLocal({ account_id, project_id }),
  ).rejects.toThrow("home bay changed");
  expect(
    query.mock.calls.some(([sql]) => sql.includes("SELECT key FROM")),
  ).toBe(false);
});
it("validates input before DB access and never writes during a read", async () => {
  await expect(
    backupAcknowledgementsLocal({ account_id, project_id, key: "*" }),
  ).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
  await backupAcknowledgementsLocal({ account_id, project_id });
  expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(
    false,
  );
});
