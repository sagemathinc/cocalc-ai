/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { render, screen } from "@testing-library/react";
import { FramePreview } from "./preview";
import type { Editor } from "./model";
const frames = [
  { id: "md", type: "markdown", label: "Markdown" },
  { id: "term", type: "terminal", label: "Terminal" },
  { id: "toc", type: "toc", label: "Contents" },
];
it("shows Markdown above Terminal on the left and Contents on the right", () => {
  const editor: Editor = {
    projectId: "p",
    path: "notes.md",
    frames,
    layout: {
      direction: "col",
      sizes: [0.7, 0.3],
      children: [
        {
          direction: "row",
          children: [{ frame: frames[0] }, { frame: frames[1] }],
        },
        { frame: frames[2] },
      ],
    },
  };
  render(<FramePreview editor={editor} onChoose={() => {}} />);
  const left = screen.getByRole("button", { name: "1 · Markdown" })
    .parentElement!.parentElement!;
  const right = screen.getByRole("button", {
    name: "3 · Contents",
  }).parentElement!;
  expect(left.style.flexDirection).toBe("column");
  expect(
    left.contains(screen.getByRole("button", { name: "2 · Terminal" })),
  ).toBe(true);
  expect(left.parentElement!.parentElement).toBe(right.parentElement);
  expect(right.parentElement!.style.flexDirection).toBe("row");
});
it("lists tabbed frames side by side, allowing wrapping in a narrow preview", () => {
  const editor: Editor = {
    projectId: "p",
    path: "notes.md",
    frames,
    layout: { tabs: true, children: frames.map((frame) => ({ frame })) },
  };
  render(<FramePreview editor={editor} onChoose={() => {}} />);
  const tabs = screen.getByText("Tabs").parentElement!;
  expect(tabs.style.flexDirection).toBe("row");
  expect(tabs.style.flexWrap).toBe("wrap");
  expect(screen.getAllByRole("button")).toHaveLength(3);
});

it("shows the number on its own line above the short label", () => {
  const editor: Editor = {
    projectId: "p",
    path: "paper.tex",
    frames: [
      { id: "src", type: "cm", label: "LaTeX Source Code", short: "Source" },
      { id: "pdf", type: "pdfjs_canvas", label: "PDF - Preview" },
    ],
    layout: {
      children: [
        {
          frame: {
            id: "src",
            type: "cm",
            label: "LaTeX Source Code",
            short: "Source",
          },
        },
        { frame: { id: "pdf", type: "pdfjs_canvas", label: "PDF - Preview" } },
      ],
    },
  };
  render(<FramePreview editor={editor} onChoose={() => {}} />);
  const source = screen.getByRole("button", { name: "1 · LaTeX Source Code" });
  const [number, label] = Array.from(
    source.querySelectorAll("strong, span span"),
  );
  expect(number.tagName).toBe("STRONG");
  expect(number.textContent).toBe("1");
  expect(label.textContent).toBe("Source");
  expect(label.style.whiteSpace).toBe("nowrap");
  // Without a short label the descriptive one is used.
  expect(
    screen.getByRole("button", { name: "2 · PDF - Preview" }).textContent,
  ).toBe("2PDF - Preview");
});
