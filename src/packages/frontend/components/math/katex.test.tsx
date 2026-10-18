/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { render } from "@testing-library/react";

import KaTeX from "./katex";

describe("KaTeX", () => {
  it("renders malformed Markdown math without an ambient jQuery global", () => {
    delete (window as any).$;

    const { container } = render(
      <KaTeX data={"$\\definitelyUnknownCommand{<&}$"} inMarkdown />,
    );

    expect(container.textContent).toContain("\\definitelyUnknownCommand{<&}");
    expect(container.querySelector("div[style*='color: red']")).not.toBeNull();
  });
});
