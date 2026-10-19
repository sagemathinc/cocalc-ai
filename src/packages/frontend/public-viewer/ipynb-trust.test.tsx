/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The public viewer's notebook never renders as trusted: the real renderer
// path delivers trust={false} to the notebook, and no caller can override it.

import { render } from "@testing-library/react";
import PublicNBViewer from "@cocalc/frontend/jupyter/nbviewer/public-nbviewer";
import PublicViewerIpynbRenderer from "./renderers/ipynb";
import { buildViewerFileContext } from "./viewer-file-context";

const seen: any[] = [];
jest.mock("@cocalc/frontend/jupyter/nbviewer/notebook", () => ({
  __esModule: true,
  default: (props) => {
    seen.push(props);
    return null;
  },
}));

const NOTEBOOK = JSON.stringify({
  cells: [{ cell_type: "markdown", metadata: {}, source: ["hello"] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

beforeEach(() => {
  seen.length = 0;
});

it("the public viewer's renderer delivers trust={false}", () => {
  render(
    <PublicViewerIpynbRenderer
      content={NOTEBOOK}
      fileContext={buildViewerFileContext({
        path: "d.ipynb",
        rawUrl: "https://raw.example/d.ipynb",
      })}
    />,
  );
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((p) => p.trust === false)).toBe(true);
});

it("a caller cannot override it", () => {
  render(<PublicNBViewer content={NOTEBOOK} {...({ trust: true } as any)} />);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((p) => p.trust === false)).toBe(true);
});
