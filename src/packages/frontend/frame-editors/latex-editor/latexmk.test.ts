/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fullRebuildCommand } from "./latexmk";

describe("fullRebuildCommand", () => {
  it("upgrades -g to -gg for a generated command", () => {
    const cmd = [
      "latexmk",
      "-pdf",
      "-f",
      "-g",
      "-bibtex",
      "-deps",
      "-synctex=1",
      "-interaction=nonstopmode",
      "paper.tex",
    ];
    expect(fullRebuildCommand(cmd)).toEqual([
      "latexmk",
      "-gg",
      "-pdf",
      "-f",
      "-bibtex",
      "-deps",
      "-synctex=1",
      "-interaction=nonstopmode",
      "paper.tex",
    ]);
  });

  it("is idempotent", () => {
    const cmd = ["latexmk", "-gg", "-pdf", "paper.tex"];
    expect(fullRebuildCommand(cmd)).toBe(cmd);
    expect(fullRebuildCommand("latexmk -gg -pdf paper.tex")).toBe(
      "latexmk -gg -pdf paper.tex",
    );
  });

  it("handles the string form", () => {
    expect(fullRebuildCommand("latexmk -pdf -g -deps paper.tex")).toBe(
      "latexmk -gg -pdf -deps paper.tex",
    );
  });

  it("keeps an absolute latexmk path", () => {
    expect(
      fullRebuildCommand(["/usr/bin/latexmk", "-pdf", "paper.tex"]),
    ).toEqual(["/usr/bin/latexmk", "-gg", "-pdf", "paper.tex"]);
  });

  it("leaves a non-latexmk command alone", () => {
    // e.g. a build command the user hardcoded in the document
    expect(fullRebuildCommand("make paper.pdf")).toBe("make paper.pdf");
    expect(fullRebuildCommand(["pdflatex", "paper.tex"])).toEqual([
      "pdflatex",
      "paper.tex",
    ]);
    expect(fullRebuildCommand([])).toEqual([]);
  });
});
