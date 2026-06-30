/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appendUrlPath, joinUrlPath } from "./url-path";

describe("url-path", () => {
  test("joinUrlPath joins paths without URL semantics", () => {
    expect(joinUrlPath("/api/", "/v1/", "projects")).toBe("/api/v1/projects");
  });

  test("appendUrlPath preserves absolute URL schemes", () => {
    expect(appendUrlPath("https://cocalc.ai", "pricing")).toBe(
      "https://cocalc.ai/pricing",
    );
    expect(
      appendUrlPath("https://cocalc.ai/base/", "/docs/", "jupyter/use-jupyter"),
    ).toBe("https://cocalc.ai/base/docs/jupyter/use-jupyter");
  });
});
