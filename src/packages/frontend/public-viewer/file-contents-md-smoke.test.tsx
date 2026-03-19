import { render, screen } from "@testing-library/react";
import PublicViewerFileContents from "./file-contents";

test("renders simple markdown content", async () => {
  render(
    <PublicViewerFileContents
      content={"# Hello\n\nThis is a test."}
      path={"/a.md"}
      rawUrl={"https://example.com/a.md?raw=1"}
    />,
  );
  expect(await screen.findByText("Hello")).toBeTruthy();
  expect(await screen.findByText("This is a test.")).toBeTruthy();
});
