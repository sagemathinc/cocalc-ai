import { render, screen } from "@testing-library/react";
import PublicViewerMarkdownRenderer from "./renderers/markdown";

test("renders simple markdown content", async () => {
  render(
    <PublicViewerMarkdownRenderer
      content={"# Hello\n\nThis is a test."}
      fileContext={{ noSanitize: false }}
    />,
  );
  expect(await screen.findByText("Hello")).toBeTruthy();
  expect(await screen.findByText("This is a test.")).toBeTruthy();
});
