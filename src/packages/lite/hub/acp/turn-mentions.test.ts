import { serializeArtifactMention } from "@cocalc/util/artifact-mentions";
import { resolveHumanTurnArtifactMentions } from "./turn-mentions";

const project_id = "756629fd-ce98-4596-8595-1071d6c019a6";
const account_id = "ca35aaf2-a22d-482b-a846-199bf58f3477";
const entry_id = "a".repeat(64);
const reference = { version: 1 as const, project_id, entry_id, name: "nb1" };
const request = {
  account_id,
  project_id,
  chat: {
    project_id,
    user_message_content: `Review ${serializeArtifactMention(reference)}`,
  },
} as any;

test("resolves current-project artifacts through an authorized point lookup", async () => {
  const getEntry = jest.fn().mockResolvedValue({
    project_id,
    entry_id,
    chat_path: "/home/user/review.chat",
    item: { thread_id: "thread", artifact_id: "artifact" },
  });
  await expect(
    resolveHumanTurnArtifactMentions(request, { getEntry }),
  ).resolves.toEqual([
    {
      name: "nb1",
      project_id,
      entry_id,
      chat_path: "/home/user/review.chat",
      thread_id: "thread",
      artifact_id: "artifact",
    },
  ]);
  expect(getEntry).toHaveBeenCalledWith({ account_id, project_id, entry_id });
});

test("cross-project references need a connector and cannot trigger lookup", async () => {
  const getEntry = jest.fn();
  const other = serializeArtifactMention({
    ...reference,
    project_id: account_id,
  });
  await expect(
    resolveHumanTurnArtifactMentions(
      {
        ...request,
        chat: { project_id, user_message_content: other },
      },
      { getEntry },
    ),
  ).rejects.toThrow("requires a project connector");
  expect(getEntry).not.toHaveBeenCalled();
});

test("missing entries and non-human turns are not bound", async () => {
  const getEntry = jest.fn().mockResolvedValue(null);
  await expect(
    resolveHumanTurnArtifactMentions(request, { getEntry }),
  ).rejects.toThrow("unavailable");
  await expect(
    resolveHumanTurnArtifactMentions(
      {
        ...request,
        chat: { ...request.chat, agent_message: true },
      },
      { getEntry },
    ),
  ).resolves.toEqual([]);
});
