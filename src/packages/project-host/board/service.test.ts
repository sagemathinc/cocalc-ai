import * as lib from "@sagemathinc/sagebrush-board";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
} from "@cocalc/util/board/names";
import { canonicalBoardPath, recordsToString } from "./service";

test("board paths are absolute and must be boards", () => {
  expect(canonicalBoardPath("plan.board.json")).toBe(
    "/home/user/plan.board.json",
  );
  expect(canonicalBoardPath("/home/user/a/../plan.board.json")).toBe(
    "/home/user/plan.board.json",
  );
  expect(() => canonicalBoardPath("plan.json")).toThrow(/not a board/);
  expect(() => canonicalBoardPath("")).toThrow(/nonempty/);
});

test("the board library's schema is the syncdb's", () => {
  expect(lib.SCHEMA.primaryKeys).toEqual(BOARD_PRIMARY_KEYS);
  expect(lib.SCHEMA.stringCols).toEqual(BOARD_STRING_COLS);
});

test("records survive the syncdb's string, in either order", () => {
  const doc = lib.cleanDoc({
    format: "sagebrush-board",
    version: 1,
    title: "T",
    nodes: [
      { id: "a", text: "one", x: 1, y: 2 },
      { id: "b", text: "two", x: 3, y: 4 },
    ],
    edges: [{ from: "a", to: "b" }],
  });
  const records = lib.toRecords(doc);
  const text = recordsToString(records);
  expect(recordsToString([...records].reverse())).toBe(text);
  const back = from_str(text, BOARD_PRIMARY_KEYS, BOARD_STRING_COLS);
  expect(lib.canonical(lib.fromRecords(back as any))).toBe(lib.canonical(doc));
});
