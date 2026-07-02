/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

jest.mock("../autosized-iframe", () => ({
  __esModule: true,
  default: ({ src, srcDoc, title }: any) => (
    <iframe src={src} srcDoc={srcDoc} title={title} />
  ),
}));

import { Html } from "../mime-types/iframe-html";

describe("Jupyter nbviewer HTML output", () => {
  it("renders ordinary HTML inline", () => {
    render(<Html value="<table><tbody><tr><td>x</td></tr></tbody></table>" />);

    expect(screen.getByText("x")).toBeInTheDocument();
    expect(screen.queryByTitle("Jupyter HTML output")).toBeNull();
  });

  it("does not wrap top-level iframe snippets in another iframe", () => {
    render(
      <Html value='<iframe title="inner" src="https://www.youtube.com/embed/x"></iframe>' />,
    );

    expect(screen.getByTitle("inner")).toBeInTheDocument();
    expect(screen.queryByTitle("Jupyter HTML output")).toBeNull();
  });

  it("isolates full HTML documents", () => {
    render(<Html value="<html><body>x</body></html>" />);

    expect(screen.getByTitle("Jupyter HTML output")).toBeInTheDocument();
    expect(screen.queryByText("x")).toBeNull();
  });
});
