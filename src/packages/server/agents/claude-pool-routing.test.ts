// Auto's pick: a host asks for a project it serves, and the pick runs on the
// account's home bay (here or across bays). The pick itself: claude-pool.test.

import { randomUUID } from "node:crypto";

let homeBay = "bay-a";
const remote = { pickClaudePool: jest.fn() };
const assertHost = jest.fn(async () => {});
const pickLocal = jest.fn(async () => ({ credential_id: "picked" }));

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
    (assertHost as any)(...args),
}));
jest.mock("./claude-pool", () => ({
  pickClaudePool: (...args: unknown[]) => (pickLocal as any)(...args),
}));

import {
  paymentSelectionsHome,
  pickClaudePoolSubscription,
} from "./payment-selections";

const account_id = randomUUID();
const host_id = randomUUID();
const target = { project_id: randomUUID(), thread_id: "t1" };
const limited = { credential_id: randomUUID(), resets_at: 1_800_000_000 };

beforeEach(() => {
  homeBay = "bay-a";
  assertHost.mockReset().mockResolvedValue(undefined);
  remote.pickClaudePool.mockReset();
  pickLocal.mockClear();
});

test("a host picks for a project it serves, on this home bay", async () => {
  expect(
    await pickClaudePoolSubscription({
      host_id,
      account_id,
      target,
      current_credential_id: "current",
      limited,
    }),
  ).toEqual({ credential_id: "picked" });
  expect(assertHost).toHaveBeenCalledWith({
    host_id,
    account_id,
    project_id: target.project_id,
  });
  expect(pickLocal).toHaveBeenCalledWith({
    account_id,
    target,
    current_credential_id: "current",
    limited,
    turn_costs: undefined,
  });
});

test("the pick runs on the account's home bay when that is another bay", async () => {
  homeBay = "bay-b";
  remote.pickClaudePool.mockResolvedValue({
    hold_until: "2026-10-30T12:00:00Z",
  });
  expect(
    await pickClaudePoolSubscription({ host_id, account_id, target }),
  ).toEqual({ hold_until: "2026-10-30T12:00:00Z" });
  expect(remote.pickClaudePool).toHaveBeenCalledWith(
    expect.objectContaining({ account_id, home_bay_id: "bay-b", target }),
  );
  expect(pickLocal).not.toHaveBeenCalled();
});

test("a host that does not serve the project gets nothing", async () => {
  assertHost.mockRejectedValueOnce(new Error("not authorized"));
  await expect(
    pickClaudePoolSubscription({ host_id, account_id, target }),
  ).rejects.toThrow("not authorized");
  expect(pickLocal).not.toHaveBeenCalled();
  expect(remote.pickClaudePool).not.toHaveBeenCalled();
});

test("the home bay refuses a stale route", async () => {
  homeBay = "bay-b";
  await expect(
    paymentSelectionsHome.pickClaudePool({
      account_id,
      home_bay_id: "bay-a",
      target,
    }),
  ).rejects.toThrow("stale agent payment account home route");
  expect(pickLocal).not.toHaveBeenCalled();
});
