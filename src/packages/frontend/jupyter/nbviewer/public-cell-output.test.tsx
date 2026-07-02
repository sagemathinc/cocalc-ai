/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

jest.mock("@cocalc/frontend/jupyter/output-messages/autosized-iframe", () => ({
  __esModule: true,
  default: ({ src, srcDoc, title }: any) => (
    <iframe src={src} srcDoc={srcDoc} title={title} />
  ),
}));

import PublicCellOutput from "./public-cell-output";

describe("PublicCellOutput HTML rendering", () => {
  it("renders ordinary HTML inline", () => {
    render(
      <PublicCellOutput
        cell={{
          output: {
            0: {
              data: {
                "text/html":
                  "<table><tbody><tr><td>inline html</td></tr></tbody></table>",
              },
            },
          },
        }}
      />,
    );

    expect(screen.getByText("inline html")).toBeInTheDocument();
    expect(screen.queryByTitle("Jupyter HTML output")).toBeNull();
  });

  it("isolates full HTML documents", () => {
    render(
      <PublicCellOutput
        cell={{
          output: {
            0: {
              data: {
                "text/html": "<html><body>document html</body></html>",
              },
            },
          },
        }}
      />,
    );

    expect(screen.getByTitle("Jupyter HTML output")).toBeInTheDocument();
    expect(screen.queryByText("document html")).toBeNull();
  });
});
