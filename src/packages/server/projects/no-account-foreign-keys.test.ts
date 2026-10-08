/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// In a multibay cluster an account has an `accounts` row only on its home
// bay. Rows owned by a project's bay routinely name accounts homed elsewhere
// (collaborators, actors), so a foreign key to `accounts` rejects them.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [join(__dirname, ".."), join(__dirname, "../../database")];
const SKIP = new Set(["node_modules", "dist", "dist-ts"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("account references", () => {
  it("never declares a foreign key to accounts", () => {
    const offenders = ROOTS.flatMap((root) => sources(root)).filter((path) =>
      /REFERENCES\s+accounts\s*\(/i.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
