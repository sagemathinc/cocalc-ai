import * as lib from "@sagemathinc/sagebrush-board";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
} from "@cocalc/util/board/names";
import { boardHandlers, canonicalBoardPath, recordsToString } from "./service";

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

test('board editing is off unless the host enables it with exactly "1"', () => {
  const opts = { client: {} as any, projectIdOf: (s: string) => s };
  for (const value of [undefined, "", "0", "true", "yes", " 1", "1 ", "01"]) {
    const env =
      value === undefined ? {} : { COCALC_PROJECT_HOST_BOARD_EDITING: value };
    expect(boardHandlers({ ...opts, env })).toBeUndefined();
  }
  const handlers = boardHandlers({
    ...opts,
    env: { COCALC_PROJECT_HOST_BOARD_EDITING: "1" },
  });
  expect(typeof handlers?.open).toBe("function");
  expect(typeof handlers?.save).toBe("function");
});
