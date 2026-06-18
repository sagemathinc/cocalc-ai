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
// NOTE (known limit): text and icon glyphs share some values (18/22/24), so this
// guard cannot tell a mis-sized TEXT 18 from an icon 18. It catches genuinely
// off-scale values (15/21/25/…). Once icon sizes are tokenized (IconBadge dedup),
// tighten ALLOWED_RAW to the icon token only and this becomes "no raw fontSize".

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
