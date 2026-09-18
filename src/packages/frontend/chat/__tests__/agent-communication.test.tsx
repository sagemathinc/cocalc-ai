import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentCommunication } from "../agent-communication";

const projectId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const peerId = "33333333-3333-4333-8333-333333333333";

function setup() {
  const api = {
    resolveIdentity: jest.fn(async () => ({ agent_id: agentId })),
    listAgentSessions: jest.fn(async () => ({
      sessions: [
        {
          agent_session_id: "44444444-4444-4444-8444-444444444444",
          account_id: "55555555-5555-4555-8555-555555555555",
          title: "Review team",
          state: "active",
          delivery_mode: "queued",
          generation: "66666666-6666-4666-8666-666666666666",
          created_by: "55555555-5555-4555-8555-555555555555",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          members: [
            {
              kind: "registered",
              member_id: agentId,
              endpoint: { project_id: projectId, agent_id: agentId },
              name: "builder",
              available: true,
              added_at: new Date().toISOString(),
            },
            {
              kind: "registered",
              member_id: peerId,
              endpoint: { project_id: projectId, agent_id: peerId },
              name: "reviewer",
              available: true,
              added_at: new Date().toISOString(),
            },
          ],
        },
      ],
    })),
  };
  return {
    api,
    props: {
      api: api as any,
      projectId,
      path: "a.chat",
      threadId: "thread",
      accountId: "account",
    },
  };
}

test("session inspection is lazy, keyboard operable, and does not submit a parent form", async () => {
  const { api, props } = setup();
  const submit = jest.fn((event) => event.preventDefault());
  const user = userEvent.setup();
  render(
    <form onSubmit={submit}>
      <AgentCommunication {...props} />
    </form>,
  );
  expect(api.resolveIdentity).not.toHaveBeenCalled();
  await user.tab();
  const toggle = screen.getByRole("button", { name: "Agent Sessions" });
  expect(document.activeElement).toBe(toggle);
  await user.keyboard("{Enter}");
  expect(await screen.findByText("Review team")).toBeTruthy();
  expect(screen.getByText("2 members")).toBeTruthy();
  expect(api.listAgentSessions).toHaveBeenCalledWith({ limit: 100 });
  expect(submit).not.toHaveBeenCalled();
});

test("read denial exposes no mutation controls", async () => {
  const { api, props } = setup();
  api.resolveIdentity.mockRejectedValue(new Error("not a collaborator"));
  const user = userEvent.setup();
  render(<AgentCommunication {...props} />);
  await user.click(screen.getByRole("button", { name: "Agent Sessions" }));
  expect(await screen.findByText(/not a collaborator/)).toBeTruthy();
  expect(screen.queryByText("Manage Agent Sessions")).toBeNull();
});
