/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  claudeNeedsProjectInternet,
  ClaudeProjectInternetNotice,
} from "./claude-internet-notice";

const openAccountSettings = jest.fn();
let network: unknown = true;

jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: (...args: any[]) => openAccountSettings(...args),
}));
jest.mock("@cocalc/frontend/project/use-project-run-quota", () => ({
  useProjectRunQuota: () => ({ runQuota: { network } }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  network = true;
});

test("only Claude connections made from inside the project need its internet", () => {
  expect(claudeNeedsProjectInternet("account-subscription")).toBe(true);
  expect(claudeNeedsProjectInternet("project-secret")).toBe(true);
  expect(claudeNeedsProjectInternet("account-api-key")).toBe(false);
});

test("a blocked project says to upgrade, with a working Upgrade button", async () => {
  network = false;
  const onBlockedChange = jest.fn();
  render(
    <ClaudeProjectInternetNotice
      projectId="project-1"
      onBlockedChange={onBlockedChange}
    />,
  );
  expect(
    screen.getByText(
      "To use Claude Code, please upgrade to any paid membership.",
    ),
  ).toBeInTheDocument();
  expect(onBlockedChange).toHaveBeenLastCalledWith(true);
  const upgrade = screen.getByRole("button", { name: "Upgrade membership" });
  upgrade.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(openAccountSettings).toHaveBeenCalledWith({ page: "membership" });
});

test("projects with internet access show nothing", () => {
  const onBlockedChange = jest.fn();
  const { container } = render(
    <ClaudeProjectInternetNotice
      projectId="project-1"
      onBlockedChange={onBlockedChange}
    />,
  );
  expect(container).toBeEmptyDOMElement();
  expect(onBlockedChange).toHaveBeenLastCalledWith(false);
});

test("sign-in on a project whose host is gone suggests another project", () => {
  const {
    claudeSignInErrorMessage,
    isProjectHostUnavailable,
  } = require("@cocalc/frontend/chat/claude-subscription-connect");
  const routing =
    "Error: unable to route 'projects.claudeSubscriptionLoginStart' to project-host for project 4cb82904-865a-4287-a4ee-1d0e0fcf7fe1; host routing info unavailable (open the project first so host info is loaded)";
  expect(isProjectHostUnavailable(routing)).toBe(true);
  expect(claudeSignInErrorMessage(routing)).toBe(
    "This project's server is not available. Select a different project, or create a new one, and try again.",
  );
  expect(claudeSignInErrorMessage("Error: timeout")).toBe(
    "Claude sign-in error: Error: timeout",
  );
});
