import {
  agentRpcPromptPrefix,
  stripAgentRpcPrompt,
} from "../agent-message-presentation";

const rpc = {
  source: {
    agent_id: "6833f1e8-fb73-47a7-9bb4-c52cedf844e7",
    project_id: "1ce4fe78-19c7-40a8-a598-947975744cd9",
  },
  agent_session_id: "4a0715b5-a7a0-4963-b2b2-292ba36776a1",
  attempt_id: "192eab37-391c-40fe-a317-adcccb1f24af",
};

test("hides the exact model-facing agent message envelope", () => {
  const prefix = agentRpcPromptPrefix(rpc);
  expect(prefix).toContain("Agent-provided content");
  expect(stripAgentRpcPrompt(`${prefix}Review complete.`, rpc)).toBe(
    "Review complete.",
  );
});

test("does not hide edited or incomplete attribution text", () => {
  const edited = `Message from agent ${rpc.source.agent_id}.\n\nReview complete.`;
  expect(stripAgentRpcPrompt(edited, rpc)).toBe(edited);
  expect(stripAgentRpcPrompt("Review complete.", rpc)).toBe("Review complete.");
});

test("supports the external-agent warning exactly", () => {
  const external = {
    ...rpc,
    source: {
      kind: "external",
      agent_id: "44444444-4444-4444-8444-444444444444",
      installation_id: "55555555-5555-4555-8555-555555555555",
      account_id: "66666666-6666-4666-8666-666666666666",
    },
  };
  const prefix = agentRpcPromptPrefix(external);
  expect(prefix).toContain("Message from external agent");
  expect(stripAgentRpcPrompt(`${prefix}External result`, external)).toBe(
    "External result",
  );
});
