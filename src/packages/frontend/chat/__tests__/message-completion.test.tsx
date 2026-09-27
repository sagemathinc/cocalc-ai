import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { redux } from "@cocalc/frontend/app-framework";
import { selectedMarkdown } from "@cocalc/frontend/editors/slate/selection-source";
import * as parser from "@cocalc/frontend/editors/slate/markdown-to-slate";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { fileURL } from "@cocalc/frontend/lib/cocalc-urls";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import { MAX_RENDERED_TEXT_CHARS } from "../paged-text";
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
  blocks,
  fileContext,
}: {
  generating: boolean;
  final?: string;
  blocks?: InlineCodexActivityBlock[];
  fileContext?: { project_id: string; path: string; directory: string };
}) {
  const [cache, setCache] = useState<InlineCodexActivityBlock[] | undefined>(
    blocks,
  );
  const [expanded, setExpanded] = useState(true);
  const message = {
    date: 2000,
    message_id: "assistant-1",
    thread_id: "thread-1",
    sender_id: "codex",
    acp_account_id: "codex",
    acp_working_directory: fileContext?.directory,
    generating,
    history: [{ content: generating ? ":robot: Thinking..." : final }],
  };
  return (
    <IntlProvider locale="en">
      <Message
        project_id={fileContext?.project_id}
        path={fileContext?.path}
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

test.each([true, false])(
  "commit-heavy messages stay bounded after formatting (generating: %s)",
  (generating) => {
    const text = "abcdef0 ".repeat(4_096);
    log(generating ? text : "");
    const parse = jest.spyOn(parser, "markdown_to_slate");
    try {
      const { container } = render(
        <Turn generating={generating} final={text} />,
      );
      expect(container.textContent).toContain("abcdef0");
      expect(parse).toHaveBeenCalled();
      expect(
        parse.mock.calls.every(
          ([text]) => text.length <= MAX_RENDERED_TEXT_CHARS,
        ),
      ).toBe(true);
    } finally {
      parse.mockRestore();
    }
  },
);

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

test("completed activity keeps guidance and agent file context on a continuation page", async () => {
  log("");
  const projectActions = jest
    .spyOn(redux, "getProjectActions")
    .mockReturnValue({
      open_file: jest.fn(),
      get_store: () => ({ get: () => undefined }),
    } as any);
  const location = {
    project_id: "11111111-1111-4111-8111-111111111111",
    path: "/home/user/chats/agent.chat",
    directory: "/home/user/work",
  };
  const blocks: InlineCodexActivityBlock[] = [
    { kind: "agent", text: "intro ".repeat(3_000) },
    {
      kind: "guidance",
      text: "context ".repeat(3_000) + "\n\n![Human image](reference.png)",
    },
    { kind: "agent", text: "![Agent image](output.png)" },
  ];
  const parse = jest.spyOn(parser, "markdown_to_slate");
  try {
    render(
      <FileContext.Provider
        value={{ ...location, urlTransform: getUrlTransform(location) }}
      >
        <Turn generating={false} blocks={blocks} fileContext={location} />
      </FileContext.Provider>,
    );
    const last = screen.getByRole("button", { name: "Last part" });
    last.focus();
    await userEvent.setup().keyboard("{Enter}");
    const human = screen.getByRole("img", { name: "Human image" });
    expect(human.closest(".cocalc-slate-guidance")).not.toBeNull();
    expect(human).toHaveAttribute(
      "src",
      fileURL({
        project_id: location.project_id,
        path: "/home/user/chats/reference.png",
      }),
    );
    expect(screen.getByRole("img", { name: "Agent image" })).toHaveAttribute(
      "src",
      fileURL({
        project_id: location.project_id,
        path: "/home/user/work/output.png",
      }),
    );
    expect(
      parse.mock.calls.every(
        ([text]) => text.length <= MAX_RENDERED_TEXT_CHARS,
      ),
    ).toBe(true);
  } finally {
    parse.mockRestore();
    projectActions.mockRestore();
  }
});

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
