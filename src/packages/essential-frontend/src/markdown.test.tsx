/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./markdown";

jest.mock("./highlighted-code", () => ({
  __esModule: true,
  default: ({
    contents,
    language,
  }: {
    contents: string;
    language?: string;
  }) => (
    <pre data-language={language} data-testid="markdown-code">
      {contents}
    </pre>
  ),
}));

test("passes an explicit fence mode to syntax highlighting", async () => {
  render(<Markdown source={"```python\nprint('hello')\n```"} />);
  expect(await screen.findByTestId("markdown-code")).toHaveAttribute(
    "data-language",
    "python",
  );
});

test("infers a language for an unlabelled code fence", async () => {
  render(<Markdown source={"```\ndef f(x):\n    return x + 1\n```"} />);
  expect(await screen.findByTestId("markdown-code")).toHaveAttribute(
    "data-language",
    "python",
  );
});
