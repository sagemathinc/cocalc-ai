import { render, screen } from "@testing-library/react";
import PublicViewerMarkdownRenderer from "./renderers/markdown";

test("renders markdown with inline math", async () => {
  render(
    <PublicViewerMarkdownRenderer
      content={"# Hello World\n\n- foo\n- bar\n- $x^3+5$"}
      fileContext={{ noSanitize: false }}
    />,
  );
  expect(await screen.findByText("Hello World")).toBeTruthy();
  expect(await screen.findByText("foo")).toBeTruthy();
  expect(await screen.findByText("bar")).toBeTruthy();
});
