/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

// The profile each caller of AutosizedIframe chooses, through the real
// component (the sandbox attribute on the rendered iframe).

import { render } from "@testing-library/react";
import IFrame from "./iframe";
import PublicCellOutput from "../nbviewer/public-cell-output";

let blobValue: string | undefined;
jest.mock("./use-blob", () => ({
  __esModule: true,
  default: () => blobValue,
}));

const OPAQUE_LEGACY = "allow-forms allow-scripts allow-presentation";
const ISOLATED = '<div id="p"></div><script>window.PLOTLYENV = {};</script>';

function frame(container: HTMLElement): HTMLIFrameElement {
  const frames = container.querySelectorAll("iframe");
  expect(frames).toHaveLength(1);
  return frames[0];
}

describe("blob-stored HTML output (iframe.tsx)", () => {
  it("a blob URL: opaque-legacy untrusted, unsandboxed only when trusted", () => {
    blobValue = "blob:https://cocalc.example/x";
    expect(
      frame(render(<IFrame sha1="a" trust={false} />).container).getAttribute(
        "sandbox",
      ),
    ).toBe(OPAQUE_LEGACY);
    expect(
      frame(render(<IFrame sha1="a" trust />).container).hasAttribute(
        "sandbox",
      ),
    ).toBe(false);
  });

  // use-blob's cache is keyed by sha1 only: HTML cached as a string by a
  // trusted render reaches an untrusted render as a string too.  That frame
  // must be sandboxed (it used to have no sandbox at all).
  it.each(["<b>cached by a trusted render</b>", ISOLATED])(
    "a string rendered untrusted is sandboxed: %s",
    (html) => {
      blobValue = html;
      const f = frame(render(<IFrame sha1="b" trust={false} />).container);
      expect(f.getAttribute("sandbox")).toBe(OPAQUE_LEGACY);
      expect(f.getAttribute("srcdoc")).toContain(html);
    },
  );

  it("isolated HTML rendered trusted keeps the trusted profile", () => {
    blobValue = ISOLATED;
    expect(
      frame(render(<IFrame sha1="c" trust />).container).hasAttribute(
        "sandbox",
      ),
    ).toBe(false);
  });
});

// Code outputs in publicly shared whiteboards and slides
// (public-viewer/renderers/board.tsx).
describe("public whiteboard/slides code output (public-cell-output.tsx)", () => {
  it("isolated HTML renders in an opaque-scripts frame", () => {
    const { container } = render(
      <PublicCellOutput
        cell={{ output: { 0: { data: { "text/html": ISOLATED } } } }}
      />,
    );
    const f = frame(container);
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("srcdoc")).toContain("PLOTLYENV");
  });
});
