import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentNetwork } from "@cocalc/conat/agents/personal";
import { AgentNetworkPills, networkColor } from "./agent-network-pills";

function network(
  id: string,
  title: string,
  state: AgentNetwork["state"] = "active",
): AgentNetwork {
  return {
    agent_network_id: id,
    account_id: "account",
    title,
    state,
    delivery_mode: "queued",
    generation: "generation",
    created_by: "account",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    members: [],
  };
}

test("network pills open details in one keyboard or pointer activation", async () => {
  const user = userEvent.setup();
  const onOpen = jest.fn();
  const first = network("11111111-1111-4111-8111-111111111111", "Release");
  const second = network(
    "22222222-2222-4222-8222-222222222222",
    "Support",
    "paused",
  );
  render(<AgentNetworkPills networks={[first, second]} onOpen={onOpen} />);

  const release = screen.getByRole("button", {
    name: "Configure Release network tag",
  });
  release.focus();
  expect(release).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledWith(first);
  await user.click(
    screen.getByRole("button", { name: "Configure Support network tag" }),
  );
  expect(onOpen).toHaveBeenLastCalledWith(second);
});

test("network colors are stable", () => {
  const value = network("33333333-3333-4333-8333-333333333333", "Stable");
  expect(networkColor(value)).toBe(networkColor({ ...value }));
});
