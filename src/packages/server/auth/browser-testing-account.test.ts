import { assertBrowserTestingAccount } from "./browser-testing-account";
import getPool from "@cocalc/database/pool";
import { assertAccountWriteOnHomeBay } from "@cocalc/server/accounts/rehome-fence";
jest.mock("@cocalc/database/pool");
jest.mock("@cocalc/server/accounts/rehome-fence");
const id = "11111111-1111-4111-8111-111111111111";
const original = process.env.COCALC_BROWSER_TEST_ACCOUNT_IDS;
const query = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  process.env.COCALC_BROWSER_TEST_ACCOUNT_IDS = id;
  jest.mocked(getPool).mockReturnValue({ query } as any);
  jest.mocked(assertAccountWriteOnHomeBay).mockResolvedValue(undefined);
  query.mockResolvedValue({
    rows: [{ groups: [], banned: false, deleted: false }],
  });
});
afterAll(() => {
  if (original === undefined)
    delete process.env.COCALC_BROWSER_TEST_ACCOUNT_IDS;
  else process.env.COCALC_BROWSER_TEST_ACCOUNT_IDS = original;
});
it("requires exact identity and explicit server designation", async () => {
  await expect(assertBrowserTestingAccount("other", id)).rejects.toThrow(
    "exact",
  );
  delete process.env.COCALC_BROWSER_TEST_ACCOUNT_IDS;
  await expect(assertBrowserTestingAccount(id, id)).rejects.toThrow(
    "designated",
  );
  expect(query).not.toHaveBeenCalled();
});
it.each([
  undefined,
  { groups: ["admin"] },
  { banned: true },
  { deleted: true },
])("rejects unavailable or privileged account %j", async (row) => {
  query.mockResolvedValue({ rows: row ? [row] : [] });
  await expect(assertBrowserTestingAccount(id, id)).rejects.toThrow(
    "active non-admin",
  );
});
it("checks authoritative ownership before the local account row", async () => {
  jest
    .mocked(assertAccountWriteOnHomeBay)
    .mockRejectedValueOnce(new Error("wrong bay"));
  await expect(assertBrowserTestingAccount(id, id)).rejects.toThrow(
    "wrong bay",
  );
  expect(query).not.toHaveBeenCalled();
  await expect(assertBrowserTestingAccount(id, id)).resolves.toBeUndefined();
});
