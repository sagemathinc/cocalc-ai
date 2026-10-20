import {
  deleted_file_variations,
  move_file_variations,
} from "@cocalc/util/delete-files";
import {
  boardJsonPath,
  boardSyncdbPath,
  isBoardJsonPath,
  isBoardSyncdbPath,
} from "./names";

test("a board's syncdb path is beside it, hidden", () => {
  expect(boardSyncdbPath("plan.board.json")).toBe(
    ".plan.board.json.sage-board",
  );
  expect(boardSyncdbPath("a/b/plan.board.json")).toBe(
    "a/b/.plan.board.json.sage-board",
  );
  expect(boardSyncdbPath("a/.plan.board.json.sage-board")).toBe(
    "a/.plan.board.json.sage-board",
  );
  expect(() => boardSyncdbPath("plan.json")).toThrow(/\.board\.json/);
});

test("and back", () => {
  expect(boardJsonPath("a/b/.plan.board.json.sage-board")).toBe(
    "a/b/plan.board.json",
  );
  expect(boardJsonPath(".plan.board.json.sage-board")).toBe("plan.board.json");
  expect(boardJsonPath("a/plan.board.json")).toBe("a/plan.board.json");
});

test("which paths are boards", () => {
  expect(isBoardJsonPath("x/Plan.Board.JSON")).toBe(true);
  expect(isBoardJsonPath("x/plan.json")).toBe(false);
  expect(isBoardJsonPath("x/plan.board")).toBe(false);
  expect(isBoardSyncdbPath("x/.plan.board.json.sage-board")).toBe(true);
  expect(isBoardSyncdbPath("x/plan.board.json")).toBe(false);
});

test("deleting or moving a board takes its syncdb along", () => {
  expect(deleted_file_variations("a/plan.board.json")).toContain(
    "a/.plan.board.json.sage-board",
  );
  expect(
    move_file_variations("a/plan.board.json", "b/new.board.json"),
  ).toContainEqual({
    src: "a/.plan.board.json.sage-board",
    dest: "b/.new.board.json.sage-board",
  });
});
