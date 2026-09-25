/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NamedAgentDirectory } from "@cocalc/conat/agents/personal";
import { NamedAgentUsage } from "./agent-limit";

const openAccountSettings = jest.fn();

jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: (...args: any[]) => openAccountSettings(...args),
}));

const directory: NamedAgentDirectory = {
  enabled: true,
  agents: [],
  usage: { active: 31, limit: 1000 },
};

const browserGetComputedStyle = window.getComputedStyle.bind(window);

beforeAll(() => {
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => browserGetComputedStyle(element));
});

afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  jest.clearAllMocks();
});

test("explains how to free named-agent slots and opens management", async () => {
  const user = userEvent.setup();
  render(<NamedAgentUsage directory={directory} />);

  const usage = screen.getByRole("button", {
    name: "31 of 1000 named-agent slots used. Learn how to free slots",
  });
  usage.focus();
  expect(usage).toHaveFocus();
  await user.keyboard("{Enter}");

  expect(
    await screen.findByRole("dialog", { name: "Named-agent slots" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Hiding an agent does not free a slot"),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Manage named agents" }));
  expect(openAccountSettings).toHaveBeenCalledWith({ page: "my-agents" });
});
