/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "antd";
import { MyAgentsPage } from "./my-agents-page";

const setPersonalMessagingState = jest.fn(async () => undefined);
const refreshNamedAgents = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account-1",
}));
jest.mock("@cocalc/frontend/agents/api", () => ({
  personalAgentApi: () => ({ setPersonalMessagingState }),
  refreshNamedAgents: (...args: any[]) => refreshNamedAgents(...args),
  useNamedAgents: () => ({
    directory: { controls: { paused: false }, agents: [] },
  }),
}));
jest.mock("@cocalc/frontend/agents/external-installations", () => ({
  ExternalAgentInstallations: () => (
    <section aria-label="External agent installations" />
  ),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

it("shows only account-wide messaging and installation controls", async () => {
  const user = userEvent.setup();
  render(<MyAgentsPage />);

  expect(screen.getByRole("heading", { name: "Agent messaging" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Pause all messaging" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Revoke all networks" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "External agent installations" }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Named Agents" })).toBeNull();
  expect(screen.queryByRole("searchbox", { name: "Search Agents" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Pause all messaging" }));
  await waitFor(() =>
    expect(setPersonalMessagingState).toHaveBeenCalledWith({ action: "pause" }),
  );
  expect(refreshNamedAgents).toHaveBeenCalled();
});

it("retains the confirmation for account-wide revocation", async () => {
  const user = userEvent.setup();
  const confirm = jest.spyOn(Modal, "confirm").mockImplementation(jest.fn());
  render(<MyAgentsPage />);

  await user.click(screen.getByRole("button", { name: "Revoke all networks" }));
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Revoke all Agent Networks?" }),
  );
  confirm.mockRestore();
});
