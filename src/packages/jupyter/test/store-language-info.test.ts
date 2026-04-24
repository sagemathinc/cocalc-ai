/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalizeLanguageInfo } from "../redux/store";

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
