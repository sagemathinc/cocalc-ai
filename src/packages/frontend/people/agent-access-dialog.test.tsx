/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentAccessDialog } from "./agent-access-dialog";

const getAgentAccess = jest.fn();
const setAgentAccess = jest.fn(async () => {});
jest.mock("./api", () => ({
  peopleApi: () => ({
    getAgentAccess: (...a) => getAgentAccess(...a),
    setAgentAccess: (...a) => setAgentAccess(...a),
  }),
}));

const props = {
  open: true,
  project_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "22222222-2222-4222-8222-222222222222",
  name: "helper",
  onClose: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

it("lets the creator ask collaborators to only view", async () => {
  getAgentAccess.mockResolvedValue({ access: "message", is_creator: true });
  const user = userEvent.setup();
  render(<AgentAccessDialog {...props} />);
  await user.click(await screen.findByRole("radio", { name: /only view/ }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setAgentAccess).toHaveBeenCalledWith({
      project_id: props.project_id,
      agent_id: props.agent_id,
      access: "view",
    }),
  );
});

it("shows the setting read-only to other collaborators", async () => {
  getAgentAccess.mockResolvedValue({ access: "view", is_creator: false });
  render(<AgentAccessDialog {...props} />);
  expect(
    await screen.findByText("Only the agent's creator can change this."),
  ).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /only view/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /only view/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});
