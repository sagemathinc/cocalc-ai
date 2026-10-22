import type { BoardOpenResult } from "@cocalc/conat/files/fs";
import {
  boardHistoryActions,
  HISTORY_UNLOADABLE_DOCS,
} from "@cocalc/util/board/history-unloadable";
import { boardHistoryView, takeRebuiltNotice } from "./board-history";

const project_id = "00000000-1000-4000-8000-000000000000";
const path = "/home/user/plan.board.json";
const base = { path, syncdbPath: "/home/user/.plan.board.json.sage-board" };
const downloadHref = (p: string, f: string) => `/${p}/files${f}?download`;

function view(result: BoardOpenResult) {
  return boardHistoryView({
    project_id,
    result,
    downloadHref,
    basePath: "/",
  });
}

test("a board that opened shows no problem", () => {
  expect(view({ ...base, state: "ok" })).toBeUndefined();
});

test("each cause offers its actions: links to the board's path, never content", () => {
  for (const cause of [
    "file-too-large",
    "file-invalid",
    "deadline",
    "failed",
    "reset-unknown",
  ] as const) {
    const v = view({
      ...base,
      state: "history-unloadable",
      cause,
      message: "why",
      actions: boardHistoryActions(cause),
      docs: HISTORY_UNLOADABLE_DOCS,
    })!;
    expect(v.links.map((l) => l.action)).toEqual([
      "open-as-text",
      "download",
      "retry",
    ]);
    // the project's streaming download of the file, at any size
    expect(v.links[1].href).toBe(downloadHref(project_id, path));
    // the JSON editor, a separate document
    expect(v.links[0].open).toEqual({ path, ext: "json" });
    expect(v.docsHref).toBe(`/docs/${HISTORY_UNLOADABLE_DOCS}`);
    expect(v.message).toBe("why");
  }
  expect(boardHistoryActions("busy")).toEqual(["retry"]);
  expect(boardHistoryActions("file-missing")).toEqual(["restore", "retry"]);
  const unknown = view({
    ...base,
    state: "history-unloadable",
    cause: "reset-unknown",
    actions: boardHistoryActions("reset-unknown"),
  })!;
  expect(unknown.title).toMatch(/may already have been rebuilt/);
});

test("the rebuilt notice is shown once per history epoch", () => {
  const store = new Map<string, unknown>();
  const seen = {
    get: (k: string) => store.get(k),
    set: (k: string, v: string) => void store.set(k, v),
  };
  const rebuilt = (history_epoch: number): BoardOpenResult => ({
    ...base,
    state: "ok",
    recovered: { reason: "board-file", time: 1, history_epoch },
  });
  const first = takeRebuiltNotice({ project_id, result: rebuilt(3), seen });
  expect(first).toBe(
    `The edit history of ${path} could not be loaded. It was archived, and the board was rebuilt from its saved file; edits not yet saved to the file may be missing.`,
  );
  expect(takeRebuiltNotice({ project_id, result: rebuilt(3), seen })).toBe(
    undefined,
  );
  // a later rebuild is told again
  expect(takeRebuiltNotice({ project_id, result: rebuilt(4), seen })).toBe(
    first,
  );
  expect(
    takeRebuiltNotice({ project_id, result: { ...base, state: "ok" }, seen }),
  ).toBeUndefined();
});
