import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  captureReplyContext,
  contextualReplyMessage,
} from "../contextual-reply-context";
import ContextualReply, { LocalCommentButton } from "../contextual-reply";
import Editor from "../contextual-reply-editor";

const privateDrafts = new Map<string, string>();
const outbox = jest.fn().mockResolvedValue({ id: "pending" });
const upload = jest
  .fn()
  .mockResolvedValue({ url: "/blobs/captured.png?uuid=image" });
jest.mock("../use-chat-composer-draft", () => ({
  useChatComposerDraft: ({ suffix }) => {
    const React = require("react");
    const [input, set] = React.useState(privateDrafts.get(suffix) ?? "");
    return {
      input,
      ready: true,
      setInput: (text) => {
        privateDrafts.set(suffix, text);
        set(text);
      },
      clearInput: async () => {
        privateDrafts.delete(suffix);
        set("");
      },
    };
  },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account",
}));
jest.mock("@cocalc/frontend/blobs/upload-image", () => ({
  uploadBlobImage: (...args) => upload(...args),
}));
jest.mock("../pending-chat-outbox", () => ({
  getPendingChatBrowserSessionId: () => "browser",
  storePendingChatSend: (...args) => outbox(...args),
  removePendingChatSend: jest.fn(),
}));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: (props) => <div {...props} />,
}));
jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: ({ value, getValueRef, onChange }) => {
    getValueRef.current = () => value;
    return (
      <textarea
        aria-label="Comment"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  },
}));
const source = {
  kind: "message" as const,
  id: "message",
  thread_id: "thread",
  title: "Assistant response",
};
const context = {
  source,
  captured_at: "now",
  quote: "exact quote",
  start: 10,
  end: 21,
  before: "prefix",
  after: "suffix",
};
const identity = {
  date: "2026-09-11T00:00:00Z",
  thread_id: "thread",
  message_id: "reply",
};
const actions: any = {
  reserveChatSendIdentity: jest.fn(() => identity),
  sendChat: jest.fn(() => identity.date),
  getMessageByDate: jest.fn(),
  getCodexConfig: jest.fn(() => undefined),
};
const props = {
  actions,
  projectId: "project",
  path: "chat.chat",
  context,
  rect: { left: 10, bottom: 50 } as DOMRect,
};
beforeEach(() => {
  jest.clearAllMocks();
  privateDrafts.clear();
  outbox.mockResolvedValue({ id: "pending" });
  actions.getMessageByDate.mockReturnValue(undefined);
});

test("captures bounded exact selection even in a large document", () => {
  const root = document.createElement("div");
  root.textContent = "x".repeat(40000) + "exact quote" + "y".repeat(40000);
  document.body.append(root);
  const range = document.createRange();
  range.setStart(root.firstChild!, 40000);
  range.setEnd(root.firstChild!, 40011);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const captured = captureReplyContext(source, root, selection);
  expect(captured).toMatchObject({
    quote: "exact quote",
    start: 40000,
    end: 40011,
  });
  expect(captured.before).toHaveLength(2048);
  expect(captured.after).toHaveLength(2048);
  expect(contextualReplyMessage("Explain", captured).acp_prompt).toContain(
    '"id":"message"',
  );
  range.setEnd(root.firstChild!, 50000);
  expect(() => captureReplyContext(source, root, selection)).toThrow(
    "Select a shorter passage",
  );
  root.remove();
  selection.removeAllRanges();
});

test("local send is durable, preserves the main draft, and carries exact context", async () => {
  privateDrafts.set("main", "Keep my valuable draft and approvals");
  const close = jest.fn();
  render(<Editor {...props} onClose={close} />);
  const input = await screen.findByRole("textbox", { name: "Comment" });
  expect(input).toHaveFocus();
  expect(screen.getByRole("dialog")).toHaveStyle({ boxSizing: "border-box" });
  fireEvent.change(input, { target: { value: "Explain this" } });
  fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(outbox).toHaveBeenCalledTimes(1);
  expect(actions.sendChat).toHaveBeenCalledWith(
    expect.objectContaining({
      preserveSelectedThread: true,
      skipDraftDelete: true,
      reply_thread_id: "thread",
      chatIdentity: identity,
      acp_prompt: expect.stringContaining('"quote":"exact quote"'),
    }),
  );
  expect(actions.sendChat.mock.calls[0][0]).not.toHaveProperty(
    "artifact_feedback",
  );
  expect(privateDrafts.get("main")).toBe(
    "Keep my valuable draft and approvals",
  );
});

test("Escape preserves a private draft and reopening restores its original context", async () => {
  const close = jest.fn();
  const mounted = render(<Editor {...props} onClose={close} />);
  fireEvent.change(await screen.findByRole("textbox"), {
    target: { value: "Unsent private thought" },
  });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(close).toHaveBeenCalled();
  expect(actions.sendChat).not.toHaveBeenCalled();
  mounted.unmount();
  render(
    <Editor
      {...props}
      context={{ ...context, quote: "different selection" }}
      onClose={close}
    />,
  );
  expect(await screen.findByRole("textbox")).toHaveValue(
    "Unsent private thought",
  );
  expect(screen.getByText("exact quote")).toBeVisible();
});

test("outbox failure retains draft and never dispatches", async () => {
  outbox.mockRejectedValueOnce(Error("offline"));
  render(<Editor {...props} onClose={jest.fn()} />);
  fireEvent.change(await screen.findByRole("textbox"), {
    target: { value: "Keep this" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
  await screen.findByText("Error: offline");
  expect(screen.getByRole("textbox")).toHaveValue("Keep this");
  expect(actions.sendChat).not.toHaveBeenCalled();
});

test("image bytes upload only on Send and reach the agent prompt", async () => {
  render(
    <Editor
      {...props}
      context={{ ...context, image: { sha256: "hash" } }}
      image={new Blob(["image"], { type: "image/png" })}
      onClose={jest.fn()}
    />,
  );
  fireEvent.change(await screen.findByRole("textbox"), {
    target: { value: "Change the colors" },
  });
  expect(upload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
  await waitFor(() => expect(actions.sendChat).toHaveBeenCalled());
  expect(actions.sendChat.mock.calls[0][0].acp_prompt).toContain(
    "![Referenced image](/blobs/captured.png?uuid=image)",
  );
});

test("a restored image draft refuses substituted image bytes", async () => {
  const first = render(
    <Editor
      {...props}
      context={{ ...context, image: { sha256: "original" } }}
      image={new Blob(["old"])}
      onClose={jest.fn()}
    />,
  );
  fireEvent.change(await screen.findByRole("textbox"), {
    target: { value: "Change this image" },
  });
  first.unmount();
  render(
    <Editor
      {...props}
      context={{ ...context, image: { sha256: "replacement" } }}
      image={new Blob(["new"])}
      onClose={jest.fn()}
    />,
  );
  await screen.findByRole("textbox");
  fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
  await screen.findByText(/image changed since this draft/);
  expect(upload).not.toHaveBeenCalled();
  expect(actions.sendChat).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveValue("Change this image");
});

test("a double click creates only one outbox entry and one send", async () => {
  let release!: () => void;
  outbox.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ id: "pending" });
      }),
  );
  render(<Editor {...props} onClose={jest.fn()} />);
  fireEvent.change(await screen.findByRole("textbox"), {
    target: { value: "Send once" },
  });
  const button = screen.getByRole("button", { name: "Send comment" });
  fireEvent.click(button);
  fireEvent.click(button);
  await act(async () => release());
  await waitFor(() => expect(actions.sendChat).toHaveBeenCalledTimes(1));
  expect(outbox).toHaveBeenCalledTimes(1);
});

test("selection exposes Reply without stealing focus, and read-only disables comments", async () => {
  const mounted = render(
    <ContextualReply {...props} source={source}>
      <p>Selectable assistant text</p>
      <LocalCommentButton />
    </ContextualReply>,
  );
  const text = screen.getByText("Selectable assistant text");
  const range = document.createRange();
  range.selectNodeContents(text);
  range.getBoundingClientRect = () => props.rect;
  act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(screen.getByRole("button", { name: "Reply" })).not.toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  await screen.findByRole("dialog");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(text.parentElement).toHaveFocus();
  mounted.unmount();
  render(
    <ContextualReply {...props} disabled source={source}>
      <p>Read only</p>
      <LocalCommentButton />
    </ContextualReply>,
  );
  expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
});
