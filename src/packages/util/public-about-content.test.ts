/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getDocsEntry } from "@cocalc/docs";

import {
  getPublicAboutIntro,
  PUBLIC_ABOUT_PRINCIPLES,
} from "./public-about-content";

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
    // The guide explains access options and limitations. CoCalc Plus has no
    // such guide, and the lead names Claude only on cocalc.ai.
    expect(getDocsEntry("ai/claude-code")?.title).toBe("Claude Code in CoCalc");
    expect(getDocsEntry("ai/claude-code", { product: "plus" })).toBeUndefined();
  });

  // Each principle keeps the limit that the docs attach to its claim.
  it("states the browser and CoCalc access limits that the docs state", () => {
    const [place, , reach] = PUBLIC_ABOUT_PRINCIPLES;
    expect(place.body).toMatch(
      / Browsing the web needs a project with internet access\.$/,
    );
    expect(getDocsEntry("projects/web-browser")?.body).toMatch(
      /Free projects have no internet access/,
    );

    expect(reach.body).toMatch(/ read-only files or full runtime,/);
    expect(reach.body).toMatch(
      / That access ends when its turn does; grant it only from a project whose collaborators you trust\.$/,
    );
    expect(getDocsEntry("ai/cocalc-access")?.body).toMatch(
      /Give access only in a source\s+project whose collaborators you trust/,
    );
  });
});
