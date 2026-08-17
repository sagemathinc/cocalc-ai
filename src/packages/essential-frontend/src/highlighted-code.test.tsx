/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import HighlightedCode from "./highlighted-code";

jest.mock("./prism-languages", () => {
  class Token {
    alias = undefined;

    constructor(
      public type: string,
      public content: string,
    ) {}
  }
  return {
    loadLanguage: jest.fn(async () => ({})),
    Prism: {
      Token,
      tokenize: jest.fn(() => [new Token("keyword", "const"), " value = 1"]),
    },
  };
});

test("renders Prism tokens after the lazy grammar loads", async () => {
  const { container } = render(
    <HighlightedCode contents="const value = 1" language="javascript" />,
  );

  expect(await screen.findByText("const")).toHaveClass("token", "keyword");
  expect(container.querySelector("code")).toHaveClass("language-javascript");
});
