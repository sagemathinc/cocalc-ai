import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useArtifactFeedbackDraft } from "../use-artifact-feedback";
import { writeChatComposerDraft } from "../use-chat-composer-draft";

jest.mock("../utils", () => ({ stableDraftKeyFromThreadKey: () => 42 }));
jest.mock("../use-chat-composer-draft", () => ({
  useChatComposerDraft: jest.fn(),
  writeChatComposerDraft: jest.fn(async () => {}),
}));
const { useChatComposerDraft } = jest.requireMock("../use-chat-composer-draft");
const feedback = {
  schema_version: 1 as const,
  thread_id: "t",
  artifact_id: "a",
  title: "Draft",
  markdown: "Hello",
  rendered_text: "Hello",
  start: 0,
  end: 5,
  quote: "Hello",
};

beforeEach(() => {
  jest.clearAllMocks();
  useChatComposerDraft.mockImplementation(function useDraft() {
    const [input, setInput] = useState("");
    return {
      input,
      setInput,
      clearInput: async () => setInput(""),
      clearComposerDraft: async () => setInput(""),
    };
  });
});

function setup(threadId = "t") {
  const actions: any = {
    syncdb: {
      get_one: (key) => ({
        ...key,
        artifact_id: "a",
        schema_version: 1,
        kind: "markdown",
        title: "Draft",
        input: "Changed live text",
      }),
    },
    setSelectedThread: jest.fn(),
    frameId: "origin-frame",
    frameTreeActions: { focus: jest.fn() },
  };
  let api: ReturnType<typeof useArtifactFeedbackDraft>;
  function Test({ selectedThread = threadId, draftKey = 7 }) {
    api = useArtifactFeedbackDraft({
      actions,
      threadId: selectedThread,
      account_id: "user",
      project_id: "project",
      path: "x.chat",
      composerDraftKey: draftKey,
    });
    return <>{api.control}</>;
  }
  const view = render(<Test />);
  return {
    actions,
    read: () => api.read(),
    captureClear: () => api.clear,
    switchThread: (selectedThread: string, draftKey: number) =>
      view.rerender(
        <Test selectedThread={selectedThread} draftKey={draftKey} />,
      ),
  };
}

test("stages a pinned quote without sending, and supports removal", async () => {
  const { actions, read } = setup();
  await act(async () => {
    await actions.stageArtifactFeedback(feedback);
  });
  expect(read()).toEqual(feedback);
  expect(screen.getByText("Draft")).toBeTruthy();
  const remove = screen.getByRole("button", {
    name: "Remove artifact feedback",
  });
  remove.focus();
  expect(document.activeElement).toBe(remove);
  fireEvent.click(remove);
  expect(read()).toBeUndefined();
  expect(actions.frameTreeActions.focus).toHaveBeenCalledWith("origin-frame");
  expect(actions.setSelectedThread).not.toHaveBeenCalled();
});

test("cross-thread staging writes the originating thread's account draft", async () => {
  const { actions } = setup("different");
  await act(async () => {
    await actions.stageArtifactFeedback(feedback);
  });
  expect(writeChatComposerDraft).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id: "user",
      path: "x.chat",
      composerDraftKey: 42,
      suffix: "artifact-feedback",
      text: JSON.stringify(feedback),
    }),
  );
  expect(actions.setSelectedThread).toHaveBeenCalledWith("t");
});

test("delayed send completion does not clear newly staged feedback", async () => {
  const { actions, read, captureClear } = setup();
  await act(async () => {
    await actions.stageArtifactFeedback(feedback);
  });
  const completeOriginalSend = captureClear();
  const next = { ...feedback, title: "New feedback" };
  await act(async () => {
    await actions.stageArtifactFeedback(next);
  });
  await act(async () => {
    await completeOriginalSend(feedback);
  });
  expect(read()).toEqual(next);
  await act(async () => {
    await captureClear()(next);
  });
  expect(read()).toBeUndefined();
});

test("a send completing after a thread switch clears only its original draft", async () => {
  const clearOld = jest.fn(async () => {});
  const clearCurrent = jest.fn(async () => {});
  let activeInput = JSON.stringify(feedback);
  let clearComposerDraft = clearOld;
  useChatComposerDraft.mockImplementation(() => ({
    input: activeInput,
    setInput: jest.fn(),
    clearInput: jest.fn(),
    clearComposerDraft,
  }));
  const { read, captureClear, switchThread } = setup();
  const completeOriginalSend = captureClear();
  const next = { ...feedback, thread_id: "other", title: "Other draft" };
  activeInput = JSON.stringify(next);
  clearComposerDraft = clearCurrent;
  switchThread("other", 8);
  expect(read()).toEqual(next);
  await act(async () => {
    await completeOriginalSend(feedback);
  });
  expect(clearOld).not.toHaveBeenCalled();
  expect(clearCurrent).toHaveBeenCalledWith(7);
  expect(clearCurrent).not.toHaveBeenCalledWith(8);
  expect(read()).toEqual(next);
});
