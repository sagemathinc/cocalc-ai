/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  codemirrorModeForLanguage,
  normalizeLanguageInfo,
} from "../redux/store";

describe("normalizeLanguageInfo", () => {
  it("replaces stale language metadata with the active kernelspec language", () => {
    expect(
      normalizeLanguageInfo({ name: "bash", codemirror_mode: "shell" }, {
        language: "python",
      } as any),
    ).toEqual({ name: "python" });
  });

  it("fills in a missing language name without dropping other fields", () => {
    expect(
      normalizeLanguageInfo(
        { codemirror_mode: { name: "python", version: 3 } },
        { language: "python" } as any,
      ),
    ).toEqual({
      codemirror_mode: { name: "python", version: 3 },
      name: "python",
    });
  });

  it("leaves language metadata unchanged when there is no kernelspec language", () => {
    const languageInfo = { name: "bash", codemirror_mode: "shell" };
    expect(normalizeLanguageInfo(languageInfo, undefined)).toBe(languageInfo);
  });
});

describe("codemirrorModeForLanguage", () => {
  it("maps common Jupyter kernel languages to loaded CodeMirror modes", () => {
    expect(codemirrorModeForLanguage("python")).toEqual({
      name: "python",
      version: 3,
    });
    expect(codemirrorModeForLanguage("julia")).toBe("text/x-julia");
    expect(codemirrorModeForLanguage("latex")).toBe("stex2");
    expect(codemirrorModeForLanguage("markdown")).toBe("gfm2");
    expect(codemirrorModeForLanguage("typescript")).toBe(
      "application/typescript",
    );
  });

  it("uses Python highlighting for Sage kernels", () => {
    expect(codemirrorModeForLanguage("sage")).toEqual({
      name: "python",
      version: 3,
    });
    expect(codemirrorModeForLanguage("SageMath")).toEqual({
      name: "python",
      version: 3,
    });
  });

  it("uses shell highlighting for Bash kernels", () => {
    expect(codemirrorModeForLanguage("bash")).toBe("shell");
  });

  it("normalizes uppercase R kernel language", () => {
    expect(codemirrorModeForLanguage("R")).toBe("r");
  });

  it("falls back to Python for unknown kernel languages", () => {
    expect(codemirrorModeForLanguage("unknown-language")).toEqual({
      name: "python",
      version: 3,
    });
  });
});
