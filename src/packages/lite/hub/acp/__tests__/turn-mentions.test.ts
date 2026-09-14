import {
  serializeAgentMention,
  type AgentMentionReference,
} from "@cocalc/util/agent-mentions";
import { resolveHumanTurnMentions } from "../turn-mentions";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";

const ref: AgentMentionReference = {
  version: 1,
  naming_account_id: "00000000-0000-4000-8000-000000000001",
  name: "reviewer",
  target: {
    project_id: "00000000-0000-4000-8000-000000000002",
    agent_id: "00000000-0000-4000-8000-000000000003",
  },
};
const request: AcpRequest = {
  account_id: "Q",
  project_id: "source",
  prompt: serializeAgentMention(ref),
  chat: {
    project_id: "source",
    path: "a.chat",
    message_date: "now",
    sender_id: "codex",
    user_message_content: serializeAgentMention(ref),
  },
};
const getMentionIdentity = jest.fn(async () => ({
  ...ref.target,
  disabled_at: null,
  created_by: "P",
  path: "b.chat",
  thread_id: "thread",
  name: "renamed",
}));
beforeEach(() => getMentionIdentity.mockClear());

it("validates copied references under the submitting human and retains exact target/name", async () => {
  expect(
    await resolveHumanTurnMentions(request, { getMentionIdentity }),
  ).toEqual([ref]);
  expect(getMentionIdentity).toHaveBeenCalledWith({
    account_id: "Q",
    project_id: "source",
    target: ref.target,
  });
});
it("does not bind historical prompt content or model-authored input", async () => {
  for (const chat of [
    { ...request.chat!, user_message_content: "plain @reviewer" },
    { ...request.chat!, agent_message: true },
    { ...request.chat!, automation_id: "scheduled" },
  ]) {
    expect(
      await resolveHumanTurnMentions(
        { ...request, chat },
        { getMentionIdentity },
      ),
    ).toEqual([]);
  }
  expect(getMentionIdentity).not.toHaveBeenCalled();
});
it("fails closed on unavailable authority without name or account fallback", async () => {
  getMentionIdentity.mockRejectedValueOnce(new Error("access denied"));
  await expect(
    resolveHumanTurnMentions(request, { getMentionIdentity }),
  ).rejects.toThrow("access denied");
  expect(getMentionIdentity).toHaveBeenCalledTimes(1);
});
