import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  clearChatDraftIfUnchanged,
  composeChatDraft,
  loadChatDraft,
  saveChatDraft,
} from "./drafts";

const values = new Map<string, string>();
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key) => Promise.resolve(values.get(key) ?? null)),
    setItem: jest.fn((key, value) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    removeItem: jest.fn((key) => {
      values.delete(key);
      return Promise.resolve();
    }),
  },
}));

const key = {
  profileId: "profile",
  projectId: "project",
  path: "agent.chat",
  threadId: "thread",
};

beforeEach(() => values.clear());

it("restores legacy text drafts and persists attachments separately from editable text", async () => {
  values.set(
    "@cocalc/mobile/chat-draft/v1/profile/project/agent.chat/thread",
    "old text",
  );
  expect(await loadChatDraft(key)).toEqual({
    text: "old text",
    attachments: [],
  });
  const composition = {
    text: "Please inspect",
    attachments: [
      { kind: "image" as const, name: "plot.png", markdown: "![plot](url)" },
    ],
  };
  await saveChatDraft(key, composition);
  expect(await loadChatDraft(key)).toEqual(composition);
  expect(composeChatDraft(composition)).toBe("Please inspect\n\n![plot](url)");
  await clearChatDraftIfUnchanged(key, composition);
  expect(await loadChatDraft(key)).toEqual({ text: "", attachments: [] });
  expect(AsyncStorage.removeItem).toHaveBeenCalled();
});

it("does not clear attachments from a newer draft after an accepted send", async () => {
  const sent = { text: "First", attachments: [] };
  const newer = {
    text: "Next",
    attachments: [
      {
        kind: "file" as const,
        name: "report.pdf",
        markdown: "[report](sandbox:/report.pdf)",
      },
    ],
  };
  await saveChatDraft(key, sent);
  await saveChatDraft(key, newer);
  await clearChatDraftIfUnchanged(key, sent);
  expect(await loadChatDraft(key)).toEqual(newer);
});
