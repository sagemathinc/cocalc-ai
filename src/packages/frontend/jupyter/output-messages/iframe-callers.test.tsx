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

// Blob-stored HTML renders like any other HTML output (html-output.tsx): trust
// plays no part, sanitized-faithful HTML renders inline and sanitized, and
// anything else is raw only inside the opaque-legacy sandbox.
describe("blob-stored HTML output (iframe.tsx)", () => {
  it.each([false, true])(
    "isolated HTML is framed in the opaque-legacy sandbox (trust=%s)",
    (trust) => {
      blobValue = ISOLATED;
      const f = frame(render(<IFrame sha1="a" trust={trust} />).container);
      expect(f.getAttribute("sandbox")).toBe(OPAQUE_LEGACY);
      expect(f.getAttribute("srcdoc")).toContain("PLOTLYENV");
    },
  );

  it.each([false, true])(
    "plain HTML renders inline and sanitized, never framed (trust=%s)",
    (trust) => {
      blobValue = "<b>cached</b>";
      const { container } = render(<IFrame sha1="b" trust={trust} />);
      expect(container.querySelectorAll("iframe")).toHaveLength(0);
      expect(container.querySelector("b")?.textContent).toBe("cached");
    },
  );

  it.each([false, true])(
    "an event handler is never inline: that HTML is framed (trust=%s)",
    (trust) => {
      blobValue = '<b onclick="parent.__xss=1">cached</b>';
      const { container } = render(<IFrame sha1="d" trust={trust} />);
      expect(container.querySelector("b[onclick]")).toBeNull();
      expect(frame(container).getAttribute("sandbox")).toBe(OPAQUE_LEGACY);
    },
  );

  it("never renders an unsandboxed frame, even for a trusted notebook", () => {
    for (const html of [ISOLATED, '<div style="color:red">x</div>']) {
      blobValue = html;
      const { container } = render(<IFrame sha1="c" trust />);
      for (const f of Array.from(container.querySelectorAll("iframe"))) {
        expect(f.getAttribute("sandbox")).toBe(OPAQUE_LEGACY);
      }
    }
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
