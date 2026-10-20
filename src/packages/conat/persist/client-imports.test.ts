/*
 * client.ts is bundled into the frontend, whose bundler can't load node:
 * modules: nothing it imports from this package may need one (board-policy.ts
 * does, so only the server loads it, through board-record-cap.ts).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BOARD_HISTORY_LIMITS } from "./board-history";
import { boardRecordCap } from "./board-record-cap";
import { storagePath } from "@cocalc/conat/sync/core-stream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { boardSyncdbPath } from "@cocalc/util/board/names";

// The package's own modules a file imports, by relative path.
function localImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/g,
  )) {
    const base = resolve(dirname(file), m[1]);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(candidate)) out.push(candidate);
    }
  }
  return out;
}

test("nothing persist/client.ts loads from this package imports a node: module", () => {
  const seen = new Set<string>();
  const stack = [join(__dirname, "client.ts")];
  const offenders: string[] = [];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    // Value imports only: a type import is erased.
    if (/(?:^|\n)\s*import\s+(?!type\b)[^;]*from\s+"node:/.test(text)) {
      offenders.push(file);
    }
    stack.push(...localImports(file));
  }
  expect(seen.has(join(__dirname, "util.ts"))).toBe(true);
  expect(offenders).toEqual([]);
});

test("a board stream is opened with the board's record cap, any other without one", () => {
  const board = storagePath({
    project_id: "00000000-0000-4000-8000-000000000000",
    name: patchesStreamName({ path: boardSyncdbPath("plan.board.json") }),
  });
  expect(boardRecordCap(board)).toBe(BOARD_HISTORY_LIMITS.recordBytes);
  expect(
    boardRecordCap(
      storagePath({
        project_id: "00000000-0000-4000-8000-000000000000",
        name: patchesStreamName({ path: "notes.md" }),
      }),
    ),
  ).toBeUndefined();
});
