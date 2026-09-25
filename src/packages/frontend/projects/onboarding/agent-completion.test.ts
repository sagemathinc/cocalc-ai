/** @jest-environment jsdom */

import {
  agentFirstRunStarted,
  beginAgentFirstRun,
  completeFirstRunWithAgent,
} from "./agent-completion";

const mockSetOtherSettings = jest.fn();
const mockGetIn = jest.fn();
const mockMarkCompleted = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({ getIn: mockGetIn }),
    getActions: () => ({ set_other_settings_and_wait: mockSetOtherSettings }),
  },
}));
jest.mock("@cocalc/frontend/app/onboarding-session", () => ({
  markFirstRunCompletedThisSession: () => mockMarkCompleted(),
}));
jest.mock("@cocalc/frontend/logger", () => ({
  getLogger: () => ({ warn: jest.fn() }),
}));

beforeEach(() => {
  sessionStorage.clear();
  mockSetOtherSettings.mockReset();
  mockSetOtherSettings.mockResolvedValue(undefined);
  mockGetIn.mockReset();
  mockMarkCompleted.mockClear();
});

test("only agent-onboarding sessions complete first run", async () => {
  await completeFirstRunWithAgent("unrelated", "project");
  expect(mockSetOtherSettings).not.toHaveBeenCalled();

  expect(agentFirstRunStarted("new-account")).toBe(false);
  beginAgentFirstRun("new-account");
  expect(agentFirstRunStarted("new-account")).toBe(true);
  await completeFirstRunWithAgent("new-account", "project");
  expect(agentFirstRunStarted("new-account")).toBe(false);
  expect(mockSetOtherSettings).toHaveBeenCalledWith(
    "first_run_onboarding_v1",
    expect.objectContaining({
      status: "completed",
      intent: "codex",
      project_id: "project",
    }),
  );
  expect(mockMarkCompleted).toHaveBeenCalledTimes(1);
  expect(
    sessionStorage.getItem("cocalc:agent-first-run:new-account"),
  ).toBeNull();
});

test("an in-progress invitation is not replaced by agent onboarding", async () => {
  beginAgentFirstRun("invited-account");
  mockGetIn.mockReturnValue({
    version: 1,
    status: "in_progress",
    intent: "project-invite",
    updated_at: new Date().toISOString(),
  });

  await completeFirstRunWithAgent("invited-account", "project");

  expect(mockSetOtherSettings).not.toHaveBeenCalled();
  expect(mockMarkCompleted).not.toHaveBeenCalled();
});
