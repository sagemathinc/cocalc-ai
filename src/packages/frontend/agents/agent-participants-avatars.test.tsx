/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";

const listAgentParticipants = jest.fn();
jest.mock("./api", () => ({
  personalAgentApi: () => ({ listAgentParticipants }),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  // The shared Tooltip reads the hide-tooltips account setting.
  useAccountOtherSetting: () => undefined,
  redux: {
    getStore: () => ({
      get_name: (id: string) => (id === "drew" ? "Drew" : "Cathy"),
    }),
  },
}));
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: ({ account_id }) => <span data-testid={`avatar-${account_id}`} />,
}));

import { AgentParticipants } from "./agent-participants-avatars";

test("a personal agent shows no participants", async () => {
  listAgentParticipants.mockResolvedValue({ account_ids: [], unavailable: 0 });
  const { container } = render(
    <AgentParticipants endpoint={{ project_id: "p", agent_id: "solo" }} />,
  );
  await waitFor(() => expect(listAgentParticipants).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});

test("a shared agent shows the other people in it", async () => {
  listAgentParticipants.mockResolvedValue({
    account_ids: ["drew", "cathy"],
    unavailable: 0,
  });
  render(
    <AgentParticipants endpoint={{ project_id: "p", agent_id: "shared" }} />,
  );
  expect(
    await screen.findByRole("group", {
      name: "Also in this agent: Drew, Cathy",
    }),
  ).toBeTruthy();
  expect(screen.getByTestId("avatar-drew")).toBeTruthy();
});
