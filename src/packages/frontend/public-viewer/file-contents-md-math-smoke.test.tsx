import { render, screen } from "@testing-library/react";
import PublicViewerFileContents from "./file-contents";

test("renders markdown with inline math", async () => {
  render(
    <PublicViewerFileContents
      content={"# Hello World\n\n- foo\n- bar\n- $x^3+5$"}
      path={"/a.md"}
      rawUrl={"https://example.com/a.md?raw=1"}
    />,
  );
  expect(await screen.findByText("Hello World")).toBeTruthy();
  expect(await screen.findByText("foo")).toBeTruthy();
  expect(await screen.findByText("bar")).toBeTruthy();
});
