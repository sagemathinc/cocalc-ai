/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import StaticMarkdown from "../static-markdown-public";

it("keeps the public code renderer and its keyboard/copy controls", () => {
  const { container } = render(
    <FileContext.Provider value={{ disableMarkdownCodebar: true }}>
      <StaticMarkdown value={"```python\nprint(1)\n```"} />
    </FileContext.Provider>,
  );
  expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  const code = container.querySelector("pre")!;
  expect(code).toHaveAttribute("tabindex", "0");
  code.focus();
  expect(code).toHaveFocus();
});
