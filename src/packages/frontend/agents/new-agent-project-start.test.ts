/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { showCodexProjectStartFailure } from "@cocalc/frontend/chat/codex-project-start-failure";
import { ensureProjectRunningForCodex } from "@cocalc/frontend/chat/codex-submit-preflight";
import { preflightNewAgentProjectStart } from "./new-agent-project-start";

jest.mock("@cocalc/frontend/chat/codex-project-start-failure", () => ({
  showCodexProjectStartFailure: jest.fn(),
}));
jest.mock("@cocalc/frontend/chat/codex-submit-preflight", () => ({
  ensureProjectRunningForCodex: jest.fn(),
}));

const ensureRunning = jest.mocked(ensureProjectRunningForCodex);
const showFailure = jest.mocked(showCodexProjectStartFailure);

beforeEach(() => {
  jest.clearAllMocks();
});

it("starts the selected project before creating the first agent turn", async () => {
  ensureRunning.mockResolvedValueOnce(undefined);

  expect(
    await preflightNewAgentProjectStart({
      projectId: "project-1",
      onOpenMembershipDetails: jest.fn(),
    }),
  ).toBe(true);
  expect(ensureRunning).toHaveBeenCalledWith(
    expect.objectContaining({ project_id: "project-1" }),
  );
  expect(showFailure).not.toHaveBeenCalled();
});

it("shows the existing project-start modal and keeps the new-agent form open on denial", async () => {
  const denial = new Error("running-project slots exhausted");
  const onOpenMembershipDetails = jest.fn();
  ensureRunning.mockRejectedValueOnce(denial);

  expect(
    await preflightNewAgentProjectStart({
      projectId: "project-1",
      onOpenMembershipDetails,
    }),
  ).toBe(false);
  expect(showFailure).toHaveBeenCalledWith({
    error: denial,
    projectId: "project-1",
    onOpenMembershipDetails,
  });
});
