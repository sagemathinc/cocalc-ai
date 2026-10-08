/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import * as parser from "@cocalc/frontend/editors/slate/markdown-to-slate";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { linkifyCommitHashes } from "../git-commit-links";
import { ChatSourceFileContext } from "../source-file-context";
import {
  TurnActivityTimeline,
  type TurnTimelineContext,
} from "../turn-activity-timeline";
import {
  buildTurnTimelineRows,
  MAX_TIMELINE_ROW_CHARS,
} from "../turn-timeline";
import type { InlineCodexActivityBlock } from "../message-state";

jest.mock("@cocalc/frontend/components/copy-to-clipboard-util", () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

const chatContext = { urlTransform: (url: string) => `/chat/${url}` };
const agentContext = { urlTransform: (url: string) => `/work/${url}` };

const appendToComposerDraft = jest.fn();
const timelineContext: TurnTimelineContext = {
  actions: { appendToComposerDraft } as any,
  projectId: "project-1",
  path: "a.chat",
  threadId: "thread-1",
  messageId: "assistant-1",
  formatAgentMarkdown: linkifyCommitHashes,
};

function Timeline({ blocks }: { blocks: InlineCodexActivityBlock[] }) {
  return (
    <ChatSourceFileContext.Provider value={chatContext}>
      <FileContext.Provider value={agentContext}>
        <TurnActivityTimeline
          rows={buildTurnTimelineRows({ blocks })}
          context={timelineContext}
        />
      </FileContext.Provider>
    </ChatSourceFileContext.Provider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

test("activity collapses blank paragraphs while preserving copied Markdown", async () => {
  const text = "First paragraph\n\n\nSecond paragraph";
  const { container } = render(<Timeline blocks={[{ kind: "agent", text }]} />);
  expect(screen.getByText("First paragraph")).toBeTruthy();
  expect(screen.getByText("Second paragraph")).toBeTruthy();
  expect(container.querySelector(".cocalc-blank-line")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy block" }));
  await waitFor(() =>
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      expect.objectContaining({ text, markdown: true }),
    ),
  );
});

test("guidance keeps chat-relative links beside agent links", () => {
  render(
    <Timeline
      blocks={[
        { kind: "agent", text: "[Agent result](result.png)" },
        {
          kind: "guidance",
          text: "[Human reference](reference.png)",
          state: "queued",
        },
      ]}
    />,
  );
  expect(screen.getByRole("region", { name: "Guidance queued" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Human reference" })).toHaveAttribute(
    "href",
    "/chat/reference.png",
  );
  expect(screen.getByRole("link", { name: "Agent result" })).toHaveAttribute(
    "href",
    "/work/result.png",
  );
});

test("unfinished agent Markdown cannot swallow the following guidance", () => {
  render(
    <Timeline
      blocks={[
        { kind: "agent", text: "```ts\nunclosed code" },
        { kind: "guidance", text: "[Human reference](reference.png)" },
      ]}
    />,
  );
  expect(screen.getByRole("link", { name: "Human reference" })).toHaveAttribute(
    "href",
    "/chat/reference.png",
  );
});

test("long guidance and agent output are parsed in bounded rows", () => {
  const parse = jest.spyOn(parser, "markdown_to_slate");
  try {
    const paragraph = "word ".repeat(200).trim();
    const long = Array.from({ length: 60 }, () => paragraph).join("\n\n");
    render(
      <Timeline
        blocks={[
          { kind: "agent", text: long },
          { kind: "guidance", text: long, state: "sent" },
        ]}
      />,
    );
    expect(parse).toHaveBeenCalled();
    expect(
      parse.mock.calls.every(
        ([text]) => text.length <= MAX_TIMELINE_ROW_CHARS + 20,
      ),
    ).toBe(true);
  } finally {
    parse.mockRestore();
  }
});

test("Quote block and Copy block act on one row's Markdown by keyboard", async () => {
  render(
    <Timeline
      blocks={[
        { kind: "agent", text: "First **point**\n\n- item" },
        { kind: "guidance", text: "Try `make -j8`", state: "sent" },
      ]}
    />,
  );
  const user = userEvent.setup();
  const agentActions = screen.getByRole("group", {
    name: "Actions for this agent output",
  });
  const quote = screen.getAllByRole("button", { name: "Quote block" })[0];
  expect(agentActions).toContainElement(quote);
  quote.focus();
  await user.keyboard("{Enter}");
  expect(appendToComposerDraft).toHaveBeenCalledWith({
    threadKey: "thread-1",
    text: "> First **point**\n> \n> - item",
  });

  // Quoting guidance stages its text, not the presentation fence.
  fireEvent.click(screen.getAllByRole("button", { name: "Quote block" })[1]);
  expect(appendToComposerDraft).toHaveBeenLastCalledWith({
    threadKey: "thread-1",
    text: "> Try `make -j8`",
  });

  fireEvent.click(screen.getAllByRole("button", { name: "Copy block" })[0]);
  await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledTimes(1));
  const request = (copyTextToClipboard as jest.Mock).mock.calls[0][0];
  expect(request).toMatchObject({
    text: "First **point**\n\n- item",
    markdown: true,
  });
  expect(request.html).toContain("<strong>point</strong>");
});

test("read-only timelines offer Copy but not Quote", () => {
  render(
    <TurnActivityTimeline
      rows={buildTurnTimelineRows({
        blocks: [{ kind: "agent", text: "done" }],
      })}
      context={{ ...timelineContext, readOnly: true }}
    />,
  );
  expect(screen.queryByRole("button", { name: "Quote block" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy block" })).toBeTruthy();
});

test("streaming output re-parses only the changed row", () => {
  const blocks: InlineCodexActivityBlock[] = [
    { kind: "agent", text: "finished paragraph" },
    { kind: "guidance", text: "guidance" },
    { kind: "agent", text: "streaming" },
  ];
  const { rerender } = render(<Timeline blocks={blocks} />);
  const parse = jest.spyOn(parser, "markdown_to_slate");
  try {
    rerender(
      <Timeline
        blocks={[
          ...blocks.slice(0, 2),
          { kind: "agent", text: "streaming more" },
        ]}
      />,
    );
    expect(parse.mock.calls.map(([text]) => text)).toEqual(["streaming more"]);
  } finally {
    parse.mockRestore();
  }
});

test("thinking is one muted line that opens to the full reasoning", () => {
  render(
    <Timeline
      blocks={[
        { kind: "agent", text: "Starting the sleep now." },
        {
          kind: "thinking",
          text: "The image is a banner.\n\nThe sleep is still running.",
        },
      ]}
    />,
  );
  const toggle = screen.getByRole("button", { name: /Thinking/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  // Collapsed: the label and a one-line excerpt, no actions or rendered body.
  expect(toggle.textContent).toContain(
    "The image is a banner. The sleep is still running.",
  );
  expect(screen.getAllByRole("button", { name: "Copy block" })).toHaveLength(1);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("The sleep is still running.")).toBeTruthy();
});
