/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// D1 design guardrail — type scale.
//
// Public-site TEXT must use the PUBLIC_TYPE tokens (see public/theme.ts), so a
// paragraph is never an ad-hoc px value again (this is the "17-vs-14 hero" class
// of bug). Our pages style inline, so we enforce it by scanning source: every
// inline `fontSize: <number>` literal must be a KNOWN value — either a token
// usage (which reads `fontSize: PUBLIC_TYPE.x`, not a number) or one of the
// decorative/icon glyph sizes that legitimately remain as raw numbers.
//
// A NEW raw value failing here means someone added an ad-hoc size: use a
// PUBLIC_TYPE token for text, or — for a genuine icon/decoration size — add the
// value below with a one-line reason. Home is intentionally OUT OF SCOPE (it is
// hand-tuned and protected, with its own display sizes 30/58 and legacy strays).
//
// KNOWN LIMITS (this is a coarse source scan — do not over-trust it; hardening
// is tracked in landing-page-issues-and-plans.md):
//   1. Text and icon glyphs share values (17/18/19/20/22/24), so a mis-sized
//      TEXT 17 reads the same as an icon 17 and passes. It reliably catches only
//      genuinely off-scale values (15/21/25/…). The original "17-vs-14" hero bug
//      would slip through both halves: 17 is allowed, and an UNSET size reverting
//      to the 14px default is invisible to any source scan.
//   2. The regex matches only `fontSize: <digits>` — it misses `font-size:` in
//      injected CSS strings, quoted "17px", no-space `fontSize:18`, and tokens.
//   3. Scope is features/products/pricing, NON-recursive — about/auth/docs/
//      guides/news/support/layout and top-level shared files are unguarded.
// The render-time half is now implemented as `expectTextSizesOnScale` in
// test-helpers.ts (paragraphs with an inline fontSize must be a PUBLIC_TYPE
// value, with a tripwire for the unset-default), run across every feature page.
// Still pending: tokenizing icon sizes so ALLOWED_RAW can shrink to "no raw text".

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Decorative / icon-glyph sizes that legitimately remain as raw fontSize today.
// (Text uses PUBLIC_TYPE.) Each maps to an <Icon> glyph or mock chrome.
const ALLOWED_RAW_FONT_SIZES = new Set([13, 17, 18, 19, 20, 22, 24]);

const PUBLIC_DIR = join(__dirname, "..");
const SCANNED_DIRS = ["features", "products", "pricing"];

function tsxSources(dir: string): string[] {
  const root = join(PUBLIC_DIR, dir);
  return readdirSync(root)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .map((name) => join(root, name));
}

describe("D1 type scale guardrail", () => {
  it("uses no ad-hoc inline fontSize values (text must use PUBLIC_TYPE)", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of tsxSources(dir)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/fontSize: (\d+)\b/g)) {
          const value = Number(match[1]);
          if (!ALLOWED_RAW_FONT_SIZES.has(value)) {
            const rel = file.slice(file.indexOf("/public/") + 1);
            offenders.push(`${rel}: ad-hoc fontSize ${value}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
