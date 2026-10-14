/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getDocsEntry } from "@cocalc/docs";

import { getPublicAboutIntro } from "./public-about-content";

describe("About page words", () => {
  it("names only Codex in the lead away from cocalc.ai", () => {
    const parts = getPublicAboutIntro(false);
    expect(parts.filter(({ path }) => path != null)).toEqual([]);
    expect(parts.map(({ text }) => text).join("")).toMatch(
      / Codex is built in\.$/,
    );
    expect(parts.map(({ text }) => text).join("")).not.toMatch(/Claude/);
  });

  it("links the lead's Claude mention to the Claude guide on cocalc.ai", () => {
    const links = getPublicAboutIntro(true).filter(({ path }) => path != null);
    expect(links).toEqual([{ path: "docs/ai/claude-code", text: "Claude" }]);
    // The guide states the preview status, so the link text does not. CoCalc
    // Plus has no such guide, and the lead names Claude only on cocalc.ai.
    expect(getDocsEntry("ai/claude-code")?.title).toBe(
      "Claude Code in CoCalc (Experimental Preview)",
    );
    expect(getDocsEntry("ai/claude-code", { product: "plus" })).toBeUndefined();
  });
});
