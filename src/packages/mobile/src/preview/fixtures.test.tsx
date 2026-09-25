beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});
import {
  createPreviewChat,
  isPreviewProfile,
  PREVIEW_PROFILE,
  previewEnabled,
} from "./fixtures";

test("ordinary builds cannot activate preview with a profile name", () => {
  expect(previewEnabled).toBe(false);
  expect(isPreviewProfile(PREVIEW_PROFILE)).toBe(false);
});

test("local conversations publish immutable snapshots and isolate independent sessions", async () => {
  const client = createPreviewChat();
  const independent = createPreviewChat();
  const before = client.getSnapshot();
  const listener = jest.fn();
  const unsubscribe = client.subscribe(listener);
  await client.sendToExistingCodexThread({
    thread_id: "preview-thread",
    text: "Local only",
  });
  const after = client.getSnapshot();
  expect(after).not.toBe(before);
  expect(after.messages).toHaveLength(before.messages.length + 2);
  expect(before.messages).toHaveLength(4);
  expect(independent.getSnapshot().messages).toHaveLength(4);
  expect(after.messages.at(-2)?.content).toBe("Local only");
  expect(listener).toHaveBeenCalledWith(after);
  unsubscribe();
  await client.loadOlderMessages?.(60);
  expect(client.getSnapshot().message_window?.has_older).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
  await client.close();
});

test("the public preview flag cannot enable fixtures in a production runtime", () => {
  const previousDev = (globalThis as any).__DEV__;
  const previousFlag = process.env.EXPO_PUBLIC_MOBILE_PREVIEW;
  try {
    process.env.EXPO_PUBLIC_MOBILE_PREVIEW = "1";
    (globalThis as any).__DEV__ = false;
    jest.isolateModules(() => {
      const fixtures = require("./fixtures");
      expect(fixtures.isPreviewProfile(PREVIEW_PROFILE)).toBe(false);
    });
    (globalThis as any).__DEV__ = true;
    jest.isolateModules(() => {
      const fixtures = require("./fixtures");
      expect(fixtures.isPreviewProfile(PREVIEW_PROFILE)).toBe(true);
      expect(fixtures.isPreviewProfile("real-account")).toBe(false);
    });
  } finally {
    (globalThis as any).__DEV__ = previousDev;
    if (previousFlag === undefined)
      delete process.env.EXPO_PUBLIC_MOBILE_PREVIEW;
    else process.env.EXPO_PUBLIC_MOBILE_PREVIEW = previousFlag;
  }
});

test("Markdown has a separate resumable conversation with the reading corpus", () => {
  const {
    previewWorkspace,
    resumePreviewChat,
    MARKDOWN_PREVIEW_THREAD,
  } = require("./fixtures");
  const agent = previewWorkspace().directory.agents.find(
    (a: any) => a.name === "Markdown",
  );
  expect(agent.thread_id).toBe(MARKDOWN_PREVIEW_THREAD);
  const chat = resumePreviewChat(agent.thread_id);
  expect(chat).toBe(resumePreviewChat(agent.thread_id));
  expect(chat).not.toBe(resumePreviewChat());
  const snapshot = chat.getSnapshot();
  expect(snapshot.threads[0].thread_id).toBe(agent.thread_id);
  expect(
    snapshot.messages.every((m: any) => m.thread_id === agent.thread_id),
  ).toBe(true);
  expect(snapshot.messages[1].content).toContain("CoCalc macro compatibility");
  expect(snapshot.message_window.has_older).toBe(false);
});
