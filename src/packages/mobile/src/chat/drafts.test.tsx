import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  appendChatDraftAttachment,
  clearChatDraftIfUnchanged,
  composeChatDraft,
  loadChatDraft,
  saveChatDraft,
  subscribeChatDraftAttachments,
  withChatAttachment,
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

it("serializes recovered upload metadata after newer edits without restoring old text", async () => {
  const attachment = {
    kind: "file" as const,
    name: "report.pdf",
    markdown: "[report](sandbox:/report.pdf)",
  };
  const saving = saveChatDraft(key, { text: "New draft", attachments: [] });
  const recovering = appendChatDraftAttachment(key, attachment);
  await Promise.all([saving, recovering]);
  await appendChatDraftAttachment(key, attachment);
  expect(await loadChatDraft(key)).toEqual({
    text: "New draft",
    attachments: [attachment],
  });
  expect(await loadChatDraft({ ...key, threadId: "different" })).toEqual({
    text: "",
    attachments: [],
  });
});

it("waits for a pending save when restoring a reopened conversation", async () => {
  const draft = { text: "Most recent edit", attachments: [] };
  const saving = saveChatDraft(key, draft);
  expect(await loadChatDraft(key)).toEqual(draft);
  await saving;
});

it("keeps edits made during recovery and notifies only the original conversation", async () => {
  const attachment = {
    kind: "image" as const,
    name: "plot.png",
    markdown: "![plot](url)",
  };
  await saveChatDraft(key, { text: "Initial", attachments: [] });
  let finish!: (value: string | null) => void;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        reading();
      }),
  );
  let current = {
    text: "New edit while recovery reads storage",
    attachments: [],
  } as Parameters<typeof withChatAttachment>[0];
  const receive = jest.fn(async (completed) => {
    current = withChatAttachment(current, completed);
    await saveChatDraft(key, current);
  });
  const other = jest.fn();
  const unsubscribe = subscribeChatDraftAttachments(key, receive);
  const unsubscribeOther = subscribeChatDraftAttachments(
    { ...key, profileId: "other" },
    other,
  );
  try {
    const recovery = appendChatDraftAttachment(key, attachment);
    await started;
    current = { ...current, text: "Edited again during storage recovery" };
    const saving = saveChatDraft(key, current);
    unsubscribe();
    finish([...values.values()][0]);
    await Promise.all([recovery, saving]);
    expect(receive).toHaveBeenCalledWith(attachment);
    expect(other).not.toHaveBeenCalled();
    expect(await loadChatDraft(key)).toEqual({
      text: current.text,
      attachments: [attachment],
    });
  } finally {
    unsubscribe();
    unsubscribeOther();
  }
});
