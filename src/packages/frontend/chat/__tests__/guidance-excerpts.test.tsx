import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import * as parser from "@cocalc/frontend/editors/slate/markdown-to-slate";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { formatMarkdownPage } from "../bounded-static-markdown";
import { linkifyCommitHashes } from "../git-commit-links";
import { codexActivityTextSource } from "../message-state";
import { MAX_RENDERED_TEXT_CHARS, PagedText } from "../paged-text";
import { ChatSourceFileContext } from "../source-file-context";
import type { TextSource } from "../text-source";

jest.mock("@cocalc/frontend/components/copy-to-clipboard-util", () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

const chatContext = { urlTransform: (url: string) => `/chat/${url}` };
const agentContext = { urlTransform: (url: string) => `/work/${url}` };

function Activity({
  source,
  followTail = false,
}: {
  source: TextSource;
  followTail?: boolean;
}) {
  return (
    <ChatSourceFileContext.Provider value={chatContext}>
      <FileContext.Provider value={agentContext}>
        <PagedText value={source} followTail={followTail} renderRanges>
          {(part) => (
            <StaticMarkdown
              value={formatMarkdownPage(part, linkifyCommitHashes)}
            />
          )}
        </PagedText>
      </FileContext.Provider>
    </ChatSourceFileContext.Provider>
  );
}

test("a guidance continuation retains chat-relative links and images beside agent content", async () => {
  const source = codexActivityTextSource([
    { kind: "agent", text: "a".repeat(16_350) },
    {
      kind: "guidance",
      text:
        "preface ".repeat(10) +
        "[Human reference](reference.png)\n\n![Human image](reference.png)",
      state: "queued",
    },
    { kind: "agent", text: "[Agent result](result.png)" },
  ]);
  const openInWorkbench = jest.fn();
  render(
    <div
      onClickCapture={(event) => {
        const anchor = (event.target as HTMLElement).closest("a[href]");
        if (anchor && !anchor.closest(".cocalc-slate-guidance")) {
          openInWorkbench(anchor.getAttribute("href"));
        }
      }}
      onClick={(event) => event.preventDefault()}
    >
      <Activity source={source} />
    </div>,
  );
  const user = userEvent.setup();
  const last = screen.getByRole("button", { name: "Last part" });
  last.focus();
  await user.keyboard("{Enter}");
  expect(last).toHaveFocus();
  expect(screen.getByRole("region", { name: "Guidance queued" })).toBeTruthy();
  const human = screen.getByRole("link", { name: "Human reference" });
  expect(human).toHaveAttribute("href", "/chat/reference.png");
  expect(screen.getByRole("img", { name: "Human image" })).toHaveAttribute(
    "src",
    "/chat/reference.png",
  );
  human.focus();
  await user.keyboard("{Enter}");
  expect(openInWorkbench).not.toHaveBeenCalled();
  const agent = screen.getByRole("link", { name: "Agent result" });
  expect(agent).toHaveAttribute("href", "/work/result.png");
  await user.click(agent);
  expect(openInWorkbench).toHaveBeenCalledWith("/work/result.png");
});

test("unfinished agent Markdown cannot swallow a guidance range", () => {
  render(
    <Activity
      source={codexActivityTextSource([
        { kind: "agent", text: "```ts\nunclosed code" },
        { kind: "guidance", text: "[Human reference](reference.png)" },
        { kind: "agent", text: "[Agent result](result.png)" },
      ])}
    />,
  );
  expect(screen.getByRole("link", { name: "Human reference" })).toHaveAttribute(
    "href",
    "/chat/reference.png",
  );
  expect(screen.getByRole("link", { name: "Agent result" })).toHaveAttribute(
    "href",
    "/work/result.png",
  );
});

test("tail guidance keeps its context and DOM on completion without materializing history", async () => {
  const body = "prefix ".repeat(300_000) + "[Human reference](reference.png)";
  const source = codexActivityTextSource([
    { kind: "guidance", text: body, state: "sent" },
  ]);
  const full = jest.spyOn(source, "toString");
  const displayFull = jest.spyOn(source.rendering!.source, "toString");
  const slices = jest.spyOn(source.rendering!.source, "slice");
  const { rerender } = render(<Activity source={source} followTail />);
  const link = screen.getByRole("link", { name: "Human reference" });
  expect(link).toHaveAttribute("href", "/chat/reference.png");
  rerender(<Activity source={source} />);
  expect(screen.getByRole("link", { name: "Human reference" })).toBe(link);
  expect(full).not.toHaveBeenCalled();
  expect(displayFull).not.toHaveBeenCalled();
  expect(
    slices.mock.calls.every(
      ([start, end]) => end - start <= MAX_RENDERED_TEXT_CHARS,
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Copy full text" }));
  await waitFor(() => expect(full).toHaveBeenCalledTimes(1));
  expect(copyTextToClipboard).toHaveBeenLastCalledWith({
    text: `\`\`\`guidance\n${body}\n\`\`\``,
  });
  expect(displayFull).not.toHaveBeenCalled();
});

test.each(["sent", "queued", "sending", "not-sent"] as const)(
  "%s guidance is lossless and parser-bounded even with long backtick fences and Unicode",
  (state) => {
    const body = "`".repeat(20_000) + "\u{1f680}".repeat(6_000);
    const source = codexActivityTextSource([
      { kind: "guidance", text: body, state },
    ]);
    const exported = source.toString();
    const parse = jest.spyOn(parser, "markdown_to_slate");
    const rendered: string[] = [];
    const { container } = render(
      <PagedText value={source} renderRanges>
        {(part) => {
          rendered.push(part);
          return <StaticMarkdown value={part} />;
        }}
      </PagedText>,
    );
    try {
      let recovered = "";
      const next = screen.getByRole("button", { name: "Next part" });
      for (;;) {
        const part = rendered[rendered.length - 1];
        const lines = part.split("\n");
        expect(lines[0]).toMatch(
          new RegExp(
            `^\x60{3,}guidance${state === "sent" ? "" : ` ${state}`}$`,
          ),
        );
        expect(lines[lines.length - 1]).toBe(lines[0].split("guidance")[0]);
        const excerpt = lines.slice(1, -1).join("\n");
        expect(excerpt).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
        recovered += excerpt;
        expect(
          container.querySelectorAll(".cocalc-slate-guidance"),
        ).toHaveLength(1);
        if (next.hasAttribute("disabled")) break;
        fireEvent.click(next);
      }
      expect(recovered).toBe(body);
      expect(parse).toHaveBeenCalled();
      expect(
        parse.mock.calls.every(
          ([text]) => text.length <= MAX_RENDERED_TEXT_CHARS,
        ),
      ).toBe(true);
      expect(source.toString()).toBe(exported);
      expect(source.slice(10, exported.length - 10)).toBe(
        exported.slice(10, -10),
      );
    } finally {
      parse.mockRestore();
    }
  },
);

test("range rendering is opt-in and has no effect on plain sources", () => {
  const source = codexActivityTextSource([
    { kind: "agent", text: "Agent" },
    { kind: "guidance", text: "Human" },
  ]);
  const child = jest.fn((part: string) => <pre>{part}</pre>);
  const { rerender } = render(<PagedText value={source}>{child}</PagedText>);
  expect(child).toHaveBeenLastCalledWith(source.toString());
  child.mockClear();
  const plain = codexActivityTextSource([
    { kind: "agent", text: "Agent only" },
  ]);
  rerender(
    <PagedText value={plain} renderRanges>
      {child}
    </PagedText>,
  );
  expect(child).toHaveBeenLastCalledWith("Agent only");
  expect(plain.rendering).toBeUndefined();
});
