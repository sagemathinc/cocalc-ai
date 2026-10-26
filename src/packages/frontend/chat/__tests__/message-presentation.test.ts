import { presentedMessageMarkdown } from "../message-presentation";

const agentId = "22222222-2222-4222-8222-222222222222";
const network = "88888888-8888-4888-8888-888888888888";
const attempt = "55555555-5555-4555-8555-555555555555";

test("plain messages are shown as they are", () => {
  expect(presentedMessageMarkdown({ sender_id: "u" } as any, "hello")).toBe(
    "hello",
  );
});

test("an agent message is its From card, without the model's warning", () => {
  const message = {
    sender_id: "u",
    agent_rpc: {
      source: { agent_id: agentId, project_id: "p1" },
      source_label: "@agent-1",
      agent_network_id: network,
      attempt_id: attempt,
    },
  } as any;
  const shown = presentedMessageMarkdown(message, "Acknowledged");
  expect(shown).toMatch(/^```agent-message /);
  expect(shown).toContain("direction=incoming");
  expect(shown).toContain(`from=${encodeURIComponent("@agent-1")}`);
  expect(shown).toContain("\nAcknowledged\n");
});
