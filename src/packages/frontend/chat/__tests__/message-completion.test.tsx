import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { selectedMarkdown } from "@cocalc/frontend/editors/slate/selection-source";
import Message from "../message";
import type { InlineCodexActivityBlock } from "../message-state";
import { useCodexLog } from "../use-codex-log";

jest.mock("../use-codex-log", () => ({ useCodexLog: jest.fn() }));
jest.mock("../agent-message-status", () => ({
  AgentMessageStatus: () => null,
  AttachedSteerStatusList: () => null,
}));
jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

const actions = {
  isLanguageModelThread: () => "codex",
  getMessagesInThread: () => [],
  getMessageById: () => undefined,
  getThreadMetadata: () => undefined,
  store: { get: () => undefined },
} as any;

function Turn({
  generating,
  final = "done",
}: {
  generating: boolean;
  final?: string;
}) {
  const [cache, setCache] = useState<InlineCodexActivityBlock[]>();
  const [expanded, setExpanded] = useState(true);
  const message = {
    date: 2000,
    message_id: "assistant-1",
    thread_id: "thread-1",
    sender_id: "codex",
    acp_account_id: "codex",
    generating,
    history: [{ content: generating ? ":robot: Thinking..." : final }],
  };
  return (
    <IntlProvider locale="en">
      <Message
        index={0}
        actions={actions}
        message={message as any}
        messages={new Map([["2000", message]])}
        account_id="viewer"
        get_user_name={() => "Codex"}
        mode="standalone"
        is_thread_body={false}
        expandedCodexActivity={expanded}
        onExpandedCodexActivityChange={setExpanded}
        cachedCodexActivityBlocks={cache}
        onCachedCodexActivityBlocksChange={setCache}
      />
    </IntlProvider>
  );
}

function log(text: string) {
  jest.mocked(useCodexLog).mockReturnValue({
    events: [
      { type: "event", event: { type: "message", text }, time: 1000, seq: 1 },
    ] as any,
    liveStatus: "connected",
    hasLogRef: true,
    loadState: "idle",
    deleteLog: jest.fn(),
  });
}

test.each(["connected", "idle"] as const)(
  "keeps the rendered commentary and selection when the final response arrives (%s)",
  (liveStatus) => {
    log("hello");
    const { rerender } = render(<Turn generating />);
    const hello = screen.getByText("hello");
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(hello);
    selection.removeAllRanges();
    selection.addRange(range);
    const copiedBefore = selectedMarkdown(range);
    expect(copiedBefore).toContain("hello");

    // Completion can disable the live preview before the persisted log arrives.
    if (liveStatus === "idle") {
      jest.mocked(useCodexLog).mockReturnValue({
        ...jest.mocked(useCodexLog).mock.results.at(-1)!.value,
        events: [],
        liveStatus,
      });
    }
    rerender(<Turn generating={false} />);
    expect(screen.getByText("hello")).toBe(hello);
    expect(selection.toString()).toBe("hello");
    expect(selectedMarkdown(range)).toBe(copiedBefore);
    expect(screen.getByText("done")).toBeVisible();
  },
);

test("completion keeps commentary from a streamed block containing the final response", () => {
  log("hello\n\ndone");
  const { rerender } = render(<Turn generating />);
  const hello = screen.getByText("hello");
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(hello);
  selection.removeAllRanges();
  selection.addRange(range);
  rerender(<Turn generating={false} />);
  expect(screen.getByText("hello")).toBeVisible();
  expect(screen.getByText("hello")).toBe(hello);
  expect(selection.toString()).toBe("hello");
  expect(screen.getAllByText("done")).toHaveLength(1);
});

test("the reader can explicitly hide completed activity with the keyboard", async () => {
  log("hello");
  const { rerender } = render(<Turn generating />);
  rerender(<Turn generating={false} />);
  const hide = screen.getByRole("button", { name: "Hide activity" });
  hide.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(screen.queryByText("hello")).toBeNull();
  expect(screen.getByText("done")).toBeVisible();
  rerender(<Turn generating={false} />);
  expect(screen.queryByText("hello")).toBeNull();
});
