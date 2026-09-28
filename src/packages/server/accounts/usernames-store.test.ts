import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  MAX_RETAINED_USERNAMES,
  getUsernameLocal,
  normalizeUsername,
  releaseUsernameRedirectLocal,
  resolveUsernameOwnerLocal,
  setUsernameLocal,
} from "./usernames-store";

const account = randomUUID();
const other = randomUUID();
const admin = randomUUID();
let bay = "seed";
const lookup = jest.fn();
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args) => lookup(...args),
}));

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 60000);
beforeEach(async () => {
  bay = "seed";
  lookup.mockReset().mockImplementation(async (account_id) => ({
    account_id,
    home_bay_id: "home",
  }));
  await getPool().query(
    "TRUNCATE account_usernames,account_username_release_log",
  );
});
afterAll(async () => {
  await getPool().end();
});

test("optional names normalize, rename, clear, and restore reserved redirects", async () => {
  expect(await getUsernameLocal(account)).toEqual({
    account_id: account,
    username: null,
    redirects: [],
  });
  expect(await resolveUsernameOwnerLocal(account)).toEqual({
    account_id: account,
    username: null,
    redirect: false,
  });
  await setUsernameLocal(account, "  Zephyr-A  ");
  await setUsernameLocal(account, "zephyr-b");
  expect(await resolveUsernameOwnerLocal("ZEPHYR-A")).toEqual({
    account_id: account,
    username: "zephyr-b",
    redirect: true,
  });
  expect(await resolveUsernameOwnerLocal("zephyr-b")).toEqual({
    account_id: account,
    username: "zephyr-b",
    redirect: false,
  });
  expect(await resolveUsernameOwnerLocal(account)).toEqual({
    account_id: account,
    username: "zephyr-b",
    redirect: true,
  });
  expect(await setUsernameLocal(account, null)).toEqual({
    account_id: account,
    username: null,
    redirects: ["zephyr-a", "zephyr-b"],
  });
  expect(await resolveUsernameOwnerLocal("zephyr-b")).toEqual({
    account_id: account,
    username: null,
    redirect: true,
  });
  expect(await setUsernameLocal(account, "zephyr-a")).toEqual({
    account_id: account,
    username: "zephyr-a",
    redirects: ["zephyr-b"],
  });
  expect(await setUsernameLocal(account, "ZEPHYR-A")).toEqual(
    await getUsernameLocal(account),
  );
  await expect(setUsernameLocal(other, "zephyr-b")).rejects.toThrow("reserved");
});

test.each([
  "",
  "compute",
  "a--b",
  "a_b",
  "a/../b",
  "x".repeat(40),
  "11111111-1111-1111-1111-111111111111",
  "11111111-1111-4111-8111-111111111111",
])("rejects invalid or UUID-like username %s", (name) => {
  expect(() => normalizeUsername(name)).toThrow();
});

test("concurrent owners cannot claim the same normalized name and losing rename rolls back", async () => {
  await setUsernameLocal(account, "zephyr-first");
  await setUsernameLocal(other, "zephyr-second");
  const results = await Promise.allSettled([
    setUsernameLocal(account, "ZEPHYR-COLLISION"),
    setUsernameLocal(other, "zephyr-collision"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const loser = results[0].status === "rejected" ? account : other;
  expect(await getUsernameLocal(loser)).toEqual({
    account_id: loser,
    username: loser === account ? "zephyr-first" : "zephyr-second",
    redirects: [],
  });
  const { rows } = await getPool().query(
    "SELECT account_id FROM account_usernames WHERE username='zephyr-collision'",
  );
  expect(rows).toHaveLength(1);
});

test("concurrent renames of one owner keep one current name and all reservations", async () => {
  await Promise.all([
    setUsernameLocal(account, "zephyr-a"),
    setUsernameLocal(account, "zephyr-b"),
  ]);
  const state = await getUsernameLocal(account);
  expect([state.username, ...state.redirects].sort()).toEqual([
    "zephyr-a",
    "zephyr-b",
  ]);
  expect(state.redirects).toHaveLength(1);
});

test("cap is atomic, includes current name, and still allows clear or own-name reuse", async () => {
  for (let i = 0; i < MAX_RETAINED_USERNAMES - 1; i++)
    await setUsernameLocal(account, `zephyr-${i}`);
  const results = await Promise.allSettled([
    setUsernameLocal(account, "zephyr-last-a"),
    setUsernameLocal(account.toUpperCase(), "zephyr-last-b"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect((await getUsernameLocal(account)).redirects).toHaveLength(
    MAX_RETAINED_USERNAMES - 1,
  );
  await expect(setUsernameLocal(account, "zephyr-overflow")).rejects.toThrow(
    "limit",
  );
  expect((await setUsernameLocal(account, null)).redirects).toHaveLength(
    MAX_RETAINED_USERNAMES,
  );
  expect((await setUsernameLocal(account, "zephyr-0")).username).toBe(
    "zephyr-0",
  );
});

test("release requires matching owner and redirect, records audit, and allows another owner to reuse", async () => {
  const release = {
    account_id: admin,
    owner_account_id: account,
    username: "zephyr-a",
    reason: "  Restore mistaken reservation  ",
  };
  await setUsernameLocal(account, "zephyr-a");
  await expect(releaseUsernameRedirectLocal(release)).rejects.toThrow(
    "No matching",
  );
  await setUsernameLocal(account, "zephyr-b");
  await expect(
    releaseUsernameRedirectLocal({ ...release, owner_account_id: other }),
  ).rejects.toThrow("No matching");
  await expect(
    releaseUsernameRedirectLocal({ ...release, reason: " " }),
  ).rejects.toThrow("reason");
  await expect(
    releaseUsernameRedirectLocal({ ...release, reason: "x".repeat(4001) }),
  ).rejects.toThrow("reason");
  await releaseUsernameRedirectLocal(release);
  expect((await getUsernameLocal(account)).redirects).toEqual([]);
  expect((await setUsernameLocal(other, "zephyr-a")).username).toBe("zephyr-a");
  const { rows } = await getPool().query(
    "SELECT owner_account_id,actor_account_id,username,reason FROM account_username_release_log",
  );
  expect(rows).toEqual([
    {
      owner_account_id: account,
      actor_account_id: admin,
      username: "zephyr-a",
      reason: "Restore mistaken reservation",
    },
  ]);
  await expect(releaseUsernameRedirectLocal(release)).rejects.toThrow(
    "No matching",
  );
  expect((await resolveUsernameOwnerLocal("zephyr-a")).account_id).toBe(other);
});

test("audit failure rolls back the release", async () => {
  await setUsernameLocal(account, "zephyr-a");
  await setUsernameLocal(account, null);
  await getPool().query(
    "ALTER TABLE account_username_release_log ADD CONSTRAINT reject_audit CHECK (reason <> 'reject-audit')",
  );
  try {
    await expect(
      releaseUsernameRedirectLocal({
        account_id: admin,
        owner_account_id: account,
        username: "zephyr-a",
        reason: "reject-audit",
      }),
    ).rejects.toThrow();
    expect((await getUsernameLocal(account)).redirects).toEqual(["zephyr-a"]);
  } finally {
    await getPool().query(
      "ALTER TABLE account_username_release_log DROP CONSTRAINT reject_audit",
    );
  }
});

test("a concurrent redirect release can never delete a reactivated current name", async () => {
  await setUsernameLocal(account, "zephyr-reuse");
  await setUsernameLocal(account, null);
  const results = await Promise.allSettled([
    setUsernameLocal(account, "zephyr-reuse"),
    releaseUsernameRedirectLocal({
      account_id: admin,
      owner_account_id: account.toUpperCase(),
      username: "zephyr-reuse",
      reason: "Cleanup race",
    }),
  ]);
  expect(results[0].status).toBe("fulfilled");
  expect(await getUsernameLocal(account)).toEqual({
    account_id: account,
    username: "zephyr-reuse",
    redirects: [],
  });
  await expect(setUsernameLocal(other, "zephyr-reuse")).rejects.toThrow(
    "reserved",
  );
});

test("unknown owners fail and non-seed stores fail closed", async () => {
  await expect(resolveUsernameOwnerLocal("zephyr-missing")).rejects.toThrow(
    "not found",
  );
  lookup.mockResolvedValueOnce(null);
  await expect(resolveUsernameOwnerLocal(account)).rejects.toThrow("not found");
  bay = "attached";
  await expect(getUsernameLocal(account)).rejects.toThrow("seed bay");
  await expect(setUsernameLocal(account, "zephyr-a")).rejects.toThrow(
    "seed bay",
  );
  await expect(resolveUsernameOwnerLocal(account)).rejects.toThrow("seed bay");
});

test("unavailable owners cannot claim or resolve, but admin inspection and redirect cleanup remain possible", async () => {
  await setUsernameLocal(account, "zephyr-old");
  await setUsernameLocal(account, "zephyr-current");
  for (const entry of [
    null,
    { account_id: account, home_bay_id: "home", banned: true },
  ]) {
    lookup.mockResolvedValue(entry);
    await expect(setUsernameLocal(account, "zephyr-next")).rejects.toThrow();
    await expect(resolveUsernameOwnerLocal(account)).rejects.toThrow();
    await expect(resolveUsernameOwnerLocal("zephyr-old")).rejects.toThrow();
    await expect(resolveUsernameOwnerLocal("zephyr-current")).rejects.toThrow();
    expect(await getUsernameLocal(account, { inspect: true })).toEqual({
      account_id: account,
      username: "zephyr-current",
      redirects: ["zephyr-old"],
    });
  }
  lookup.mockResolvedValue(null);
  await releaseUsernameRedirectLocal({
    account_id: admin,
    owner_account_id: account,
    username: "zephyr-old",
    reason: "Deleted owner cleanup",
  });
  expect(
    (await getUsernameLocal(account, { inspect: true })).redirects,
  ).toEqual([]);
});
