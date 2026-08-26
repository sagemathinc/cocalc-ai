/** @jest-environment jsdom */
/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";

import { buildErrorToast, NO_PDF } from "./error-toast";

describe("buildErrorToast", () => {
  it("emphasizes the cause below the summary", () => {
    const { node, text } = buildErrorToast(NO_PDF, "Runaway argument?");
    render(<>{node}</>);
    const cause = screen.getByText("Runaway argument?");
    expect(cause).toHaveStyle({ fontWeight: "bold" });
    expect(screen.getByText(NO_PDF, { exact: false })).toBeInTheDocument();
    expect(text).toBe(`${NO_PDF} Runaway argument?`);
  });

  it("falls back to the summary alone when there is no cause", () => {
    for (const cause of [undefined, "", "   "]) {
      const { node, text } = buildErrorToast(NO_PDF, cause);
      expect(node).toBe(NO_PDF);
      expect(text).toBe(NO_PDF);
    }
  });

  it("does not repeat a cause identical to the summary", () => {
    const { node, text } = buildErrorToast(NO_PDF, ` ${NO_PDF} `);
    expect(node).toBe(NO_PDF);
    expect(text).toBe(NO_PDF);
  });
});
