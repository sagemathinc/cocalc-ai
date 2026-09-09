import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { artifactKey } from "@cocalc/chat";
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
      get_one: () => ({
        ...artifactKey(feedback),
        artifact_id: "a",
        schema_version: 1,
        kind: "markdown",
        title: "Draft",
        input: "Changed live text",
      }),
    },
    setSelectedThread: jest.fn(),
  };
  let api: ReturnType<typeof useArtifactFeedbackDraft>;
  function Test() {
    api = useArtifactFeedbackDraft({
      actions,
      threadId,
      account_id: "user",
      project_id: "project",
      path: "x.chat",
      composerDraftKey: 7,
    });
    return <>{api.control}</>;
  }
  render(<Test />);
  return { actions, read: () => api.read(), captureClear: () => api.clear };
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
