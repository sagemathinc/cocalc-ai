const query = jest.fn();
const fence = jest.fn(({ fn }) => fn({ query }));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  withAccountRehomeWriteFence: (opts) => fence(opts),
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-changes",
  () => ({
    bumpCollaborationRevision: jest.fn(),
  }),
);
import {
  chatAliasTarget,
  readPersonAliases,
  writePersonAlias,
} from "./aliases";
import { PERSON_ALIASES_SETTING } from "@cocalc/util/private-alias";
const account = "11111111-1111-4111-8111-111111111111";
const person = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue({ rows: [{ aliases: {} }] });
});

test("person writes are fenced, normalized, scoped, and preserve other settings", async () => {
  const access = jest.fn(async () => {});
  await expect(
    writePersonAlias(account, person, " Alice ", access),
  ).resolves.toEqual({ alias: "alice" });
  expect(access).toHaveBeenCalledTimes(1);
  expect(fence).toHaveBeenCalledWith(
    expect.objectContaining({ account_id: account }),
  );
  expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), [
    account,
    PERSON_ALIASES_SETTING,
  ]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("jsonb_set"), [
    account,
    PERSON_ALIASES_SETTING,
    JSON.stringify({ [person]: "alice" }),
  ]);
});
test("only the requesting account owns collisions and renaming/removal", async () => {
  query.mockResolvedValue({
    rows: [{ aliases: { [person]: "alice", [other]: "bob" } }],
  });
  await expect(
    writePersonAlias(account, person, "bob", async () => {}),
  ).rejects.toThrow("already use");
  expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
    false,
  );
  await expect(
    writePersonAlias(account, person, "", async () => {}),
  ).resolves.toEqual({ alias: null });
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("jsonb_set"), [
    account,
    PERSON_ALIASES_SETTING,
    JSON.stringify({ [other]: "bob" }),
  ]);
});
test("inaccessible people and malformed aliases cannot mutate preferences", async () => {
  await expect(
    writePersonAlias(account, person, "alice", async () => {
      throw Error("access denied");
    }),
  ).rejects.toThrow("access denied");
  await expect(
    writePersonAlias(account, person, "../alice", async () => {}),
  ).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});
test("reads and chat candidates are account-private and ambiguity fails closed", async () => {
  await readPersonAliases(account);
  expect(query).toHaveBeenLastCalledWith(expect.any(String), [
    account,
    PERSON_ALIASES_SETTING,
  ]);
  const target = {
    project_id: other,
    kind: "conversation",
    resource_id: "stable-thread",
  };
  query.mockResolvedValue({ rows: [target] });
  await expect(chatAliasTarget(account, " Weekly ")).resolves.toEqual(target);
  expect(query).toHaveBeenLastCalledWith(
    expect.stringContaining("n.account_id=$1"),
    [account, "weekly"],
  );
  query.mockResolvedValue({
    rows: [target, { ...target, resource_id: "other" }],
  });
  await expect(chatAliasTarget(account, "weekly")).resolves.toBeNull();
  query.mockResolvedValue({ rows: [] });
  await expect(chatAliasTarget(account, "weekly")).resolves.toBeNull();
});
