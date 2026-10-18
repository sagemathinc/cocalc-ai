/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

// If sanitizing an element throws, html-ssr must not fall back to rendering
// it with its unsanitized attributes.

import { render } from "@testing-library/react";
import HTML from "./html-ssr";
import * as sanitize from "./sanitize-html";

jest.mock("./sanitize-html", () => {
  const actual = jest.requireActual("./sanitize-html");
  return {
    ...actual,
    sanitizeHtmlAttributes: jest.fn(actual.sanitizeHtmlAttributes),
  };
});

it("renders nothing for an element whose sanitizing throws", () => {
  (sanitize.sanitizeHtmlAttributes as jest.Mock).mockImplementationOnce(() => {
    throw Error("boom");
  });
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  const { container } = render(
    <HTML value='<div class="ant-modal" style="position: fixed">overlay</div><p>after</p>' />,
  );
  log.mockRestore();
  expect(container.innerHTML).not.toMatch(/ant-modal|position|overlay/);
  expect(container.querySelector("p")?.textContent).toBe("after");
});
