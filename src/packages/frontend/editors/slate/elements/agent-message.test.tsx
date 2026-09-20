/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AgentMessageElement,
  agentMessageFromMarkdownFence,
} from "./agent-message";

jest.mock("../markdown-to-slate", () => ({
  markdown_to_slate: (value: string) => [{ text: value }],
}));

const inspectAgentNetworkAttempt = jest.fn();
jest.mock("@cocalc/frontend/agents/api", () => ({
  personalAgentApi: () => ({ inspectAgentNetworkAttempt }),
  useNamedAgents: () => ({ directory: undefined }),
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
}));
jest.mock("@cocalc/frontend/projects/project-title", () => ({
  ProjectTitle: ({ project_id }) => <span>{project_id}</span>,
}));

const agent_network_id = "11111111-1111-4111-8111-111111111111";
const attempt_id = "22222222-2222-4222-8222-222222222222";

test("parses exact correlation metadata but keeps uncorrelated quotes readable", () => {
  expect(
    agentMessageFromMarkdownFence({
      info: `agent-message ${agent_network_id} ${attempt_id}`,
      value: "Peer result",
    }),
  ).toMatchObject({ type: "agent-message", agent_network_id, attempt_id });
  expect(
    agentMessageFromMarkdownFence({
      info: `agent-message ${agent_network_id} ${attempt_id} from=%40reviewer`,
      value: "Peer result",
    }),
  ).toMatchObject({ source_label: "@reviewer" });
  expect(
    agentMessageFromMarkdownFence({
      info: `agent-message direction=outgoing to=%40builder`,
      value: "Peer result",
    }),
  ).toMatchObject({ direction: "outgoing", source_label: "@builder" });
  expect(
    agentMessageFromMarkdownFence({
      info: `agent-message from=Agent source=${attempt_id} project=${agent_network_id}`,
      value: "Legacy peer result",
    }),
  ).toMatchObject({
    source_agent_id: attempt_id,
    source_project_id: agent_network_id,
  });
  expect(
    agentMessageFromMarkdownFence({
      info: "agent-message forged metadata",
      value: "Peer result",
    }),
  ).toBeUndefined();
  expect(
    agentMessageFromMarkdownFence({
      info: "agent-message",
      value: "Editable historical quote",
    }),
  ).toMatchObject({ type: "agent-message" });
});

test("shows retained evidence without claiming that editable content is verified", async () => {
  inspectAgentNetworkAttempt.mockResolvedValue({
    agent_network_id,
    attempt_id,
    network_generation: "33333333-3333-4333-8333-333333333333",
    source_member_id: "44444444-4444-4444-8444-444444444444",
    target_member_id: "55555555-5555-4555-8555-555555555555",
    configured_delivery: "live",
    effective_delivery: "live-guidance",
    outcome: "accepted",
    observed_at: "2026-09-18T12:00:00.000Z",
  });
  render(
    <AgentMessageElement
      attributes={{} as any}
      element={
        {
          type: "agent-message",
          agent_network_id,
          attempt_id,
          source_label: "@reviewer",
          children: [{ text: "Edited peer result" }],
        } as any
      }
    >
      Edited peer result
    </AgentMessageElement>,
  );
  expect(screen.getByText(/From @reviewer/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Inspect delivery" }));
  await waitFor(() =>
    expect(screen.getByText("Accepted for delivery")).toBeVisible(),
  );
  expect(screen.getByText("Delivered as guidance")).toBeVisible();
  expect(screen.getByText(/not task completion/i)).toBeVisible();
  expect(screen.getByText(agent_network_id)).not.toBeVisible();
  fireEvent.click(screen.getByText("Technical details"));
  expect(screen.getByText(agent_network_id)).toBeVisible();
  expect(screen.getByText(attempt_id)).toBeVisible();
});

test("missing evidence degrades to an explicit unavailable state", async () => {
  inspectAgentNetworkAttempt.mockResolvedValue(undefined);
  render(
    <AgentMessageElement
      attributes={{} as any}
      element={
        {
          type: "agent-message",
          agent_network_id,
          attempt_id,
          children: [{ text: "Historical quote" }],
        } as any
      }
    >
      Historical quote
    </AgentMessageElement>,
  );
  fireEvent.click(screen.getByRole("button", { name: /inspect/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Delivery details are unavailable",
  );
});
