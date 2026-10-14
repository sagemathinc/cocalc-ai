/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The agent's error when its project can't use computers: the owning bay's
// explanation when it has one, else a generic owner-only message (never a
// rule that no longer exists).

const attestProject = jest.fn();
const explainProjectIneligibility = jest.fn();

jest.mock("./routing", () => ({
  accountHomeBay: async () => "bay-0",
  computersAtBay: () => ({ attestProject, explainProjectIneligibility }),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveProjectOwningBay: async () => ({ owning_bay_id: "bay-0" }),
}));
jest.mock("./relay", () => ({ relayToComputer: jest.fn() }));
// The site's computers switch is on (see enabled.test.ts for off).
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ computers_enabled: true }),
}));

import { agentComputerRequest } from "./agent";

const run: any = {
  account_id: "00000000-0000-4000-8000-000000000001",
  project_id: "00000000-0000-4000-8000-000000000002",
  agent_id: "00000000-0000-4000-8000-000000000003",
  run_id: "00000000-0000-4000-8000-000000000004",
  expires_at: new Date(Date.now() + 60_000),
};

describe("the agent's ineligibility message", () => {
  beforeEach(() => {
    attestProject.mockResolvedValue({ payload: { eligible: false } });
  });

  it("uses the owning bay's reason", async () => {
    explainProjectIneligibility.mockResolvedValue(
      "this project has been deleted",
    );
    await expect(
      agentComputerRequest(run, { action: "computer", op: "list" }),
    ).rejects.toThrow("this project has been deleted");
  });

  it.each([
    ["the explanation fails", () => Promise.reject(new Error("timeout"))],
    ["it raced to eligible", () => Promise.resolve(null)],
  ])("falls back to the owner-only rule when %s", async (_label, answer) => {
    explainProjectIneligibility.mockImplementation(answer);
    const err: Error = await agentComputerRequest(run, {
      action: "computer",
      op: "list",
    }).catch((e) => e);
    expect(err.message).toMatch(/only collaborator is you/);
    expect(err.message).not.toMatch(/shar/i);
  });
});
