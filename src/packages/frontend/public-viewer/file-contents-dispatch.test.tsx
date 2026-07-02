import { render, screen } from "@testing-library/react";

import PublicViewerFileContents, {
  publicViewerFileNeedsContent,
} from "./file-contents";

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

jest.mock("./renderers/chat", () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => (
    <div data-testid="chat-renderer">{content}</div>
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

test("dispatches chat files to the chat viewer", async () => {
  render(
    <PublicViewerFileContents
      content={'{"event":"chat","history":[{"content":"hello"}]}'}
      path="session.chat"
      rawUrl="https://example.com/session.chat"
      fileContext={{ noSanitize: false }}
    />,
  );

  expect(await screen.findByTestId("chat-renderer")).toBeTruthy();
  expect(screen.queryByTestId("codemirror-renderer")).toBeNull();
});

test("dispatches html files to a sandboxed raw-url iframe", () => {
  render(
    <PublicViewerFileContents
      content={
        "<html><body><script>window.rendered = true;</script></body></html>"
      }
      path="Figure4.html"
      rawUrl="https://example.com/Figure4.html"
      fileContext={{ noSanitize: false }}
    />,
  );

  const iframe = screen.getByTitle("Figure4.html");
  expect(iframe.getAttribute("src")).toBe("https://example.com/Figure4.html");
  expect(iframe.getAttribute("srcdoc")).toBeNull();
  expect(iframe.getAttribute("sandbox")).toBe(
    "allow-scripts allow-forms allow-popups allow-downloads",
  );
  expect(screen.queryByTestId("codemirror-renderer")).toBeNull();
});

test("does not require fetched content for html previews", () => {
  expect(publicViewerFileNeedsContent("Figure4.html")).toBe(false);
  expect(publicViewerFileNeedsContent("notes.txt")).toBe(true);
});
