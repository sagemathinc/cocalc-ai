import { fireEvent, render, screen } from "@testing-library/react";
import { EditableMarkdown } from "@cocalc/frontend/editors/slate/editable-markdown";
import * as parser from "@cocalc/frontend/editors/slate/markdown-to-slate";
import { selectedMarkdown } from "@cocalc/frontend/editors/slate/selection-source";
import { MAX_RENDERED_TEXT_CHARS, PagedText } from "../paged-text";

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

test("read-only Slate retains structured selections without parsing the entire response", () => {
  const parse = jest.spyOn(parser, "markdown_to_slate");
  try {
    const { container } = render(
      <PagedText
        value={"**bold phrase**\n\n" + "a long paragraph ".repeat(250_000)}
      >
        {(part) => (
          <EditableMarkdown
            value={part}
            read_only
            enableUpload={false}
            minimal
            hidePath
            disableWindowing
            noVfill
            showEditBar={false}
            height="auto"
            autoMinHeight={0}
          />
        )}
      </PagedText>,
    );
    expect(container.querySelectorAll("[data-slate-editor]")).toHaveLength(1);
    const bold = container.querySelector("strong")!;
    const range = document.createRange();
    range.selectNodeContents(bold);
    expect(selectedMarkdown(range)).toContain("**bold phrase**");
    fireEvent.click(screen.getByRole("button", { name: "Next part" }));
    expect(container.querySelectorAll("[data-slate-editor]")).toHaveLength(1);
    expect(parse.mock.calls.length).toBeGreaterThan(0);
    expect(
      parse.mock.calls.every(
        ([value]) => value.length <= MAX_RENDERED_TEXT_CHARS,
      ),
    ).toBe(true);
  } finally {
    parse.mockRestore();
  }
});
