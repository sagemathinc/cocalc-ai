/** @jest-environment jsdom */

import { render } from "@testing-library/react";

import StaticMarkdown from "../static-markdown";

describe("StaticMarkdown heading ids", () => {
  it("generates CSS-safe heading ids from punctuation-heavy markdown headings", () => {
    const { container } = render(
      <StaticMarkdown
        value={"## Why run CoCalc Star on your own computer / VM?\n"}
      />,
    );

    const heading = container.querySelector("h2");
    expect(heading?.id).toBe("why-run-cocalc-star-on-your-own-computer-vm");
    expect(() => heading?.matches(`#${heading.id}`)).not.toThrow();
  });
});
