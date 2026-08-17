/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("chat-client dependency boundary", () => {
  it("does not depend on UI, browser globals, or backend-only packages", () => {
    const files = sourceFiles(join(__dirname));
    const production = files.filter((file) => !file.endsWith(".test.ts"));
    for (const file of production) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/@cocalc\/frontend/);
      expect(source).not.toMatch(/from ["']react(?:-native)?["']/);
      expect(source).not.toMatch(/from ["'](?:fs|node:fs|node:path)["']/);
      expect(source).not.toMatch(/\b(?:window|document|localStorage)\b/);
    }
  });
});
