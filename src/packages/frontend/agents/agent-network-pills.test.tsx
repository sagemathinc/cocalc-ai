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

test("network pills filter from the keyboard and expose overflow", async () => {
  const user = userEvent.setup();
  const onSelect = jest.fn();
  const first = network("11111111-1111-4111-8111-111111111111", "Release");
  const second = network(
    "22222222-2222-4222-8222-222222222222",
    "Support",
    "paused",
  );
  render(
    <AgentNetworkPills
      networks={[first, second]}
      selectedNetworkId={first.agent_network_id}
      onSelect={onSelect}
    />,
  );

  const release = screen.getByRole("button", { name: "Release" });
  release.focus();
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledWith(first);

  await user.click(screen.getByText("+1"));
  await user.click(await screen.findByRole("button", { name: "Support" }));
  expect(onSelect).toHaveBeenLastCalledWith(second);
});

test("network colors are stable", () => {
  const value = network("33333333-3333-4333-8333-333333333333", "Stable");
  expect(networkColor(value)).toBe(networkColor({ ...value }));
});
