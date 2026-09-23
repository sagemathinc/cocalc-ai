/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ContextualReply from "@cocalc/frontend/chat/contextual-reply";
import StaticMarkdown from "../static-markdown";
import { selectedMarkdown } from "../selection-source";

it("preserves list structure, bold, italic, code and links", () => {
  const { container } = render(
    <StaticMarkdown
      value={
        "- **bold** and *italic*\n- [link](https://example.com) and `code`"
      }
    />,
  );
  const list = container.querySelector("ul")!;
  const range = document.createRange();
  range.selectNodeContents(list);
  const markdown = selectedMarkdown(range);
  expect(markdown).toContain("**bold**");
  expect(markdown).toMatch(/[*_]italic[*_]/);
  expect(markdown).toContain("[link](https://example.com)");
  expect(markdown).toContain("`code`");
  expect(markdown.match(/^\s*[-*] /gm)).toHaveLength(2);
});

it("trims partial leaves without losing their formatting or adding other text", () => {
  const { container } = render(
    <StaticMarkdown value={"before **bold phrase** after"} />,
  );
  const text = container.querySelector("strong")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 7);
  expect(selectedMarkdown(range).trim()).toBe("**ld ph**");
});

it("preserves nested lists", () => {
  const { container } = render(
    <StaticMarkdown value={"- parent\n  - **nested**\n- sibling"} />,
  );
  const range = document.createRange();
  range.selectNodeContents(container.querySelector("ul")!);
  const markdown = selectedMarkdown(range);
  expect(markdown).toMatch(/\n +[-*] \*\*nested\*\*/);
});

it("preserves math and fenced code when quoting a complete passage", () => {
  const { container } = render(
    <StaticMarkdown value={"Use $x^2$:\n\n```python\nprint(1)\n```"} />,
  );
  const range = document.createRange();
  range.selectNodeContents(container.querySelector(".cocalc-slate-render")!);
  const markdown = selectedMarkdown(range);
  expect(markdown).toContain("$x^2$");
  expect(markdown).toContain("```python\nprint(1)\n```");
});

it("quotes only the selected code, preserving the language", () => {
  const { container } = render(
    <StaticMarkdown value={"```text\nfirst\nsecond\nthird\n```"} />,
  );
  const text = container.querySelector("pre")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 12);
  expect(selectedMarkdown(range).trim()).toBe("```text\nsecond\n```");
});

it("clips selections spanning prose and part of a code block", () => {
  const { container } = render(
    <StaticMarkdown value={"Prose\n\n```text\nfirst\nsecond\n```"} />,
  );
  const range = document.createRange();
  range.setStart(container.querySelector("p")!.firstChild!.firstChild!, 0);
  range.setEnd(container.querySelector("pre")!.firstChild!, 5);
  const markdown = selectedMarkdown(range);
  expect(markdown).toContain("Prose");
  expect(markdown).toContain("```text\nfirst\n```");
  expect(markdown).not.toContain("second");
});

it("requires expansion before quoting a truncated code preview", () => {
  const source = "```text\none\ntwo\nthree\nfour\nfive\nsix\nhidden\n```";
  const { container } = render(<StaticMarkdown value={source} />);
  const range = document.createRange();
  range.selectNodeContents(container.querySelector(".cocalc-slate-render")!);
  expect(() => selectedMarkdown(range)).toThrow(/expand/i);
  fireEvent.click(screen.getByRole("button", { name: /lines.*hidden/ }));
  range.selectNodeContents(container.querySelector(".cocalc-slate-render")!);
  expect(selectedMarkdown(range).trim()).toBe(source);
});

it("leaves the draft untouched when Quote cannot map a collapsed code preview", () => {
  const appendToComposerDraft = jest.fn();
  const sendChat = jest.fn();
  const { container } = render(
    <ContextualReply
      actions={{ appendToComposerDraft, sendChat } as any}
      projectId="project"
      path="thread.chat"
      source={{
        kind: "message",
        id: "message",
        thread_id: "thread",
        title: "Assistant",
      }}
    >
      <StaticMarkdown
        value={"```text\none\ntwo\nthree\nfour\nfive\nsix\nhidden\n```"}
      />
    </ContextualReply>,
  );
  const range = document.createRange();
  range.selectNodeContents(container.querySelector("pre")!);
  range.getBoundingClientRect = () => ({ left: 10, bottom: 50 }) as DOMRect;
  act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  fireEvent.click(screen.getByRole("button", { name: "Quote" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/expand/i);
  expect(appendToComposerDraft).not.toHaveBeenCalled();
  expect(sendChat).not.toHaveBeenCalled();
});

it("quotes highlighted code using the keyboard without sending", async () => {
  const appendToComposerDraft = jest.fn();
  const sendChat = jest.fn();
  const { container } = render(
    <ContextualReply
      actions={{ appendToComposerDraft, sendChat } as any}
      projectId="project"
      path="thread.chat"
      source={{
        kind: "message",
        id: "message",
        thread_id: "thread",
        title: "Assistant",
      }}
    >
      <StaticMarkdown
        value={'```python\nprint("first")\nprint("second")\n```'}
      />
    </ContextualReply>,
  );
  const text = container.querySelectorAll("pre .token.string")[1].firstChild!;
  const range = document.createRange();
  range.setStart(text, 1);
  range.setEnd(text, 7);
  range.getBoundingClientRect = () => ({ left: 10, bottom: 50 }) as DOMRect;
  act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(selectedMarkdown(range).trim()).toBe("```python\nsecond\n```");
  const quote = screen.getByRole("button", { name: "Quote" });
  quote.focus();
  expect(quote).toHaveFocus();
  act(() => {
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(quote).toBeInTheDocument();
  expect(quote).toHaveFocus();
  await userEvent.setup().keyboard("{Enter}");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(quote).not.toBeInTheDocument();
  expect(appendToComposerDraft).toHaveBeenCalledWith({
    threadKey: "thread",
    text: "> ```python\n> second\n> ```",
  });
  expect(sendChat).not.toHaveBeenCalled();
  expect(container.firstChild).toHaveFocus();
});
