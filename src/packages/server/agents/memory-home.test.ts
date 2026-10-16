/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Every memory request runs on the account's home bay.

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

let mockHome = "bay-0";
let mockHere = "bay-0";
const mockRemote = jest.fn();
const mockMemory = {
  agent: jest.fn(async () => ({ ok: "agent" })),
  turnIndex: jest.fn(async () => undefined),
  owner: jest.fn(async () => ({ ok: "owner" })),
};

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => mockHere,
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: mockHome }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/agent-rpc", () => ({
  createAgentRpcControlClient: (_client: unknown, bay: string) => ({
    memory: (opts: unknown) => mockRemote(bay, opts),
  }),
}));
jest.mock("./memory", () => ({ agentMemory: () => mockMemory }));

import { memoryHomeControl, withMemoryHome } from "./memory-home";

beforeEach(() => {
  mockHome = "bay-0";
  mockHere = "bay-0";
  mockRemote.mockReset().mockResolvedValue({ ok: "remote" });
  for (const fn of Object.values(mockMemory)) fn.mockClear();
});

test("a request for an account homed here runs here", async () => {
  await expect(
    withMemoryHome(ACCOUNT, {
      kind: "agent",
      project_id: PROJECT,
      request: { action: "memory", op: "list" },
    }),
  ).resolves.toEqual({ ok: "agent" });
  expect(mockMemory.agent).toHaveBeenCalledWith(
    ACCOUNT,
    PROJECT,
    { action: "memory", op: "list" },
    undefined,
  );
  // No memory is a null index, not undefined, over the wire.
  await expect(
    withMemoryHome(ACCOUNT, { kind: "turn-index", project_id: PROJECT }),
  ).resolves.toBeNull();
  expect(mockRemote).not.toHaveBeenCalled();
});

test("a request for an account homed elsewhere goes to its home bay", async () => {
  mockHome = "bay-1";
  await expect(
    withMemoryHome(ACCOUNT, { kind: "owner", request: { op: "status" } }),
  ).resolves.toEqual({ ok: "remote" });
  expect(mockRemote).toHaveBeenCalledWith("bay-1", {
    account_id: ACCOUNT,
    home_bay_id: "bay-1",
    request: { kind: "owner", request: { op: "status" } },
  });
  expect(mockMemory.owner).not.toHaveBeenCalled();
});

test("the home bay refuses a request routed to the wrong bay", async () => {
  // Routed to bay-0 for an account that has since moved to bay-1.
  mockHome = "bay-1";
  await expect(
    memoryHomeControl({
      account_id: ACCOUNT,
      home_bay_id: "bay-0",
      request: { kind: "owner", request: { op: "status" } },
    }),
  ).rejects.toThrow("stale agent memory home route");
  expect(mockMemory.owner).not.toHaveBeenCalled();
});

test("malformed requests are refused before any routing", async () => {
  await expect(
    withMemoryHome("not-an-account", {
      kind: "owner",
      request: { op: "status" },
    }),
  ).rejects.toThrow("invalid account");
  await expect(
    withMemoryHome(ACCOUNT, { kind: "turn-index", project_id: "nope" } as any),
  ).rejects.toThrow("invalid agent memory request");
  await expect(
    withMemoryHome(ACCOUNT, { kind: "other" } as any),
  ).rejects.toThrow("invalid agent memory request");
});
