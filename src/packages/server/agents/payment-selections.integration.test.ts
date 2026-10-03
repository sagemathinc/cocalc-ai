import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";

let homeBay = "bay-a";
const remote = {
  get: jest.fn(),
  list: jest.fn(),
  set: jest.fn(),
  copy: jest.fn(),
  resolve: jest.fn(),
};
const assertHost = jest.fn(async () => {});

jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: homeBay }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-a",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/agent-payment-selections", () => ({
  createAgentPaymentSelectionsClient: () => remote,
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  assertAccountWriteOnHomeBay: async () => {},
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: (...args: unknown[]) =>
    assertHost(...args),
}));

import {
  copyPaymentSelection,
  getPaymentSelections,
  listPaymentSelections,
  paymentSelectionsHome,
  resolvePaymentSelection,
  setPaymentSelections,
} from "./payment-selections";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const codex = (credential_id: string) =>
  ({
    version: 1,
    provider: "codex",
    mode: "credential",
    credential_id,
  }) as const;
const claude = (credential_id: string) =>
  ({
    version: 1,
    provider: "claude-code",
    mode: "account-subscription",
    credential_id,
  }) as const;

describeDb("agent payment selections (account home bay)", () => {
  beforeAll(async () => {
    await syncSchema({
      agent_payment_selections: SCHEMA.agent_payment_selections,
    });
  });
  beforeEach(() => {
    homeBay = "bay-a";
    assertHost.mockReset().mockResolvedValue(undefined);
    for (const fn of Object.values(remote)) fn.mockReset();
  });

  test("a choice is per account and per agent, and the same on every read", async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const project_id = randomUUID();
    const target = { project_id, thread_id: "t1", path: "/home/user/a.chat" };
    await setPaymentSelections({
      account_id: alice,
      targets: [{ ...target, title: "builder" }],
      selection: codex(A),
    });
    const mine = await getPaymentSelections({
      account_id: alice,
      targets: [target, { project_id, thread_id: "t2" }],
    });
    expect(mine.selections).toEqual([
      expect.objectContaining({
        project_id,
        thread_id: "t1",
        path: "/home/user/a.chat",
        title: "builder",
        selection: codex(A),
      }),
    ]);
    const theirs = await getPaymentSelections({
      account_id: bob,
      targets: [target],
    });
    expect(theirs.selections).toEqual([]);
  });

  test("bulk set moves every selected agent; clearing makes them follow the default", async () => {
    const account_id = randomUUID();
    const project_id = randomUUID();
    const targets = ["a", "b", "c"].map((thread_id) => ({
      project_id,
      thread_id,
    }));
    await setPaymentSelections({ account_id, targets, selection: codex(A) });
    await setPaymentSelections({
      account_id,
      defaults: ["codex"],
      selection: codex(A),
    });
    expect(
      await setPaymentSelections({
        account_id,
        targets: targets.slice(0, 2),
        selection: codex(B),
      }),
    ).toEqual({ updated: 2 });
    let listed = await listPaymentSelections({ account_id });
    expect(
      Object.fromEntries(
        listed.selections.map((r) => [
          r.thread_id,
          (r.selection as any).credential_id,
        ]),
      ),
    ).toEqual({ a: B, b: B, c: A });
    expect(listed.defaults.codex).toEqual(codex(A));
    await setPaymentSelections({
      account_id,
      targets: [targets[2]],
      selection: null,
    });
    listed = await listPaymentSelections({ account_id });
    expect(listed.selections.map((r) => r.thread_id).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  test("migration never overwrites an existing choice", async () => {
    const account_id = randomUUID();
    const target = { project_id: randomUUID(), thread_id: "t" };
    await setPaymentSelections({
      account_id,
      targets: [target],
      selection: codex(B),
    });
    await setPaymentSelections({
      account_id,
      targets: [target],
      selection: codex(A),
      only_if_absent: true,
    });
    const { selections } = await getPaymentSelections({
      account_id,
      targets: [target],
    });
    expect(selections[0].selection).toEqual(codex(B));
  });

  test("a fresh or forked conversation keeps the choice", async () => {
    const account_id = randomUUID();
    const project_id = randomUUID();
    const from = { project_id, thread_id: "old" };
    const to = { project_id, thread_id: "new", path: "/home/user/a.chat" };
    await setPaymentSelections({
      account_id,
      targets: [from],
      selection: claude(A),
    });
    expect(await copyPaymentSelection({ account_id, from, to })).toEqual({
      copied: true,
    });
    const { selections } = await getPaymentSelections({
      account_id,
      targets: [to],
    });
    expect(selections[0]).toMatchObject({
      thread_id: "new",
      selection: claude(A),
    });
  });

  test("hosts resolve only for a project they serve, with the default as fallback", async () => {
    const account_id = randomUUID();
    const project_id = randomUUID();
    const host_id = randomUUID();
    await setPaymentSelections({
      account_id,
      defaults: ["claude-code"],
      selection: claude(B),
    });
    await setPaymentSelections({
      account_id,
      targets: [{ project_id, thread_id: "pinned" }],
      selection: claude(A),
    });
    expect(
      await resolvePaymentSelection({
        host_id,
        account_id,
        project_id,
        thread_id: "pinned",
        provider: "claude-code",
      }),
    ).toEqual({ selection: claude(A), default: claude(B) });
    expect(
      await resolvePaymentSelection({
        host_id,
        account_id,
        project_id,
        thread_id: "follows",
        provider: "claude-code",
      }),
    ).toEqual({ default: claude(B) });
    expect(assertHost).toHaveBeenCalledWith({
      host_id,
      account_id,
      project_id,
    });
    assertHost.mockRejectedValueOnce(new Error("not authorized"));
    await expect(
      resolvePaymentSelection({
        host_id,
        account_id,
        project_id,
        thread_id: "pinned",
        provider: "claude-code",
      }),
    ).rejects.toThrow("not authorized");
    const { selections } = await listPaymentSelections({ account_id });
    expect(selections[0].last_used_at).toBeTruthy();
  });

  test("rejects anything that is not a credential reference", async () => {
    const account_id = randomUUID();
    const target = { project_id: randomUUID(), thread_id: "t" };
    await expect(
      setPaymentSelections({
        account_id,
        targets: [target],
        selection: { ...codex(A), api_key: "sk-secret" } as any,
      }),
    ).rejects.toThrow();
    await expect(
      setPaymentSelections({
        account_id,
        defaults: ["codex"],
        selection: { version: 1, provider: "codex", mode: "default" },
      }),
    ).rejects.toThrow("cannot follow itself");
    await expect(
      setPaymentSelections({
        account_id,
        defaults: ["claude-code"],
        selection: codex(A),
      }),
    ).rejects.toThrow("provider mismatch");
  });

  test("routes to the account's home bay and refuses stale routes", async () => {
    const account_id = randomUUID();
    homeBay = "bay-b";
    remote.set.mockResolvedValue({ updated: 1 });
    await setPaymentSelections({
      account_id,
      targets: [{ project_id: randomUUID(), thread_id: "t" }],
      selection: codex(A),
    });
    expect(remote.set).toHaveBeenCalledWith(
      expect.objectContaining({ account_id, home_bay_id: "bay-b" }),
    );
    // This bay is not the home: a direct inter-bay call is refused.
    await expect(
      paymentSelectionsHome.list({ account_id, home_bay_id: "bay-a" }),
    ).rejects.toThrow("stale agent payment account home route");
  });
});
