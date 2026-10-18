/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import PublicViewerIpynbRenderer from "./renderers/ipynb";
import { buildViewerFileContext } from "./viewer-file-context";

jest.mock("@cocalc/frontend/codemirror/static", () => ({
  __esModule: true,
  default: {
    runMode: (value: string, _mode: unknown, append: (text: string) => void) =>
      append(value),
  },
}));

function notebook(outputs: object[]): string {
  return JSON.stringify({
    cells: [
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        source: ["x"],
        outputs,
      },
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        name: "python3",
        language: "python",
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  });
}

function markdownNotebook(source: string): string {
  return JSON.stringify({
    cells: [{ cell_type: "markdown", metadata: {}, source: [source] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
}

// A 1x1 PNG, as Jupyter attachments and pasted images embed them.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function html(value: string) {
  return {
    output_type: "display_data",
    data: { "text/html": value },
    metadata: {},
  };
}

// The context the public viewer really uses (noSanitize: true, raw-URL
// transforms, viewer anchors).
function renderPublic(content: string) {
  const fileContext = buildViewerFileContext({
    path: "dir/demo.ipynb",
    rawUrl: "https://raw.example/share/dir/demo.ipynb",
  });
  expect(fileContext.noSanitize).toBe(true);
  return render(
    <PublicViewerIpynbRenderer content={content} fileContext={fileContext} />,
  ).container;
}

describe("public notebooks render as untrusted", () => {
  beforeEach(() => {
    (window as any).__xss = undefined;
  });

  it("sanitizes inline HTML output", async () => {
    const root = renderPublic(
      notebook([
        html(
          `<div><b>visible</b><img src="x.png" onerror="window.__xss=1">` +
            `<script>window.__xss=2</script><style>body{display:none}</style>` +
            `<svg><a><animate attributeName="href" values="javascript:window.__xss=3"/><text>t</text></a></svg>` +
            `<span style="position:fixed" class="c" id="i">s</span></div>`,
        ),
      ]),
    );
    expect(await screen.findByText("visible")).toBeTruthy();
    expect(root.querySelector("script, style, svg, animate")).toBeNull();
    expect(root.innerHTML).not.toMatch(/onerror|position:\s*fixed|__xss/);
    expect((window as any).__xss).toBeUndefined();
  });

  it("keeps the viewer's URL and link handling", async () => {
    const root = renderPublic(
      notebook([
        html(
          `<div><img src="plot.png" alt="plot"><a href="other.ipynb">next</a></div>`,
        ),
      ]),
    );
    await screen.findByText("next");
    expect(root.querySelector("img[alt=plot]")?.getAttribute("src")).toBe(
      "https://raw.example/share/dir/plot.png",
    );
    expect(root.querySelector("a")?.getAttribute("href")).not.toBe(
      "other.ipynb",
    );
  });

  it("puts full documents in an opaque sandboxed frame", async () => {
    renderPublic(
      notebook([
        html(
          `<html><body><h2>doc</h2><script>parent.__xss=4</script></body></html>`,
        ),
      ]),
    );
    const iframe = await screen.findByTitle("Jupyter HTML output");
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(iframe.hasAttribute("sandbox")).toBe(true);
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("does not run JavaScript output", async () => {
    const root = renderPublic(
      notebook([
        {
          output_type: "display_data",
          data: { "application/javascript": "window.__xss=5" },
          metadata: {},
        },
      ]),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect((window as any).__xss).toBeUndefined();
    expect(root.querySelector("script")).toBeNull();
  });

  it("keeps data: images in Markdown cells and in HTML output", async () => {
    for (const content of [
      markdownNotebook(`Pasted ![pasted](${PNG}) image`),
      markdownNotebook(`<img src="${PNG}" alt="pasted"> image`),
      notebook([html(`<p>output <img src="${PNG}" alt="pasted"></p>`)]),
    ]) {
      const root = renderPublic(content);
      await screen.findAllByText(/image|output/);
      const img = root.querySelector("img");
      expect(img?.getAttribute("src")).toBe(PNG);
    }
  });

  it("keeps an instructor's safe styles in Markdown cells", async () => {
    const root = renderPublic(
      markdownNotebook(
        '<div style="background-color: #ffffcc; padding: 8px">A styled instructor box</div>\n',
      ),
    );
    await screen.findByText("A styled instructor box");
    const box = [...root.querySelectorAll<HTMLElement>("div")]
      .filter((d) => d.textContent?.trim() === "A styled instructor box")
      .pop();
    expect(box?.style.backgroundColor).toBe("rgb(255, 255, 204)");
  });
});
