import { render, screen } from "@testing-library/react";

import PublicViewerFileContents from "./file-contents";

jest.mock("./renderers/markdown", () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

jest.mock("./renderers/codemirror", () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => (
    <div data-testid="codemirror-renderer">{content}</div>
  ),
}));

test("dispatches markdown files to the rendered markdown viewer", async () => {
  render(
    <PublicViewerFileContents
      content={"# Rendered Markdown\n\nThis should not be source text."}
      path="notes.md"
      rawUrl="https://example.com/notes.md"
      fileContext={{ noSanitize: false }}
    />,
  );

  expect(await screen.findByTestId("markdown-renderer")).toBeTruthy();
  expect(screen.queryByTestId("codemirror-renderer")).toBeNull();
});
