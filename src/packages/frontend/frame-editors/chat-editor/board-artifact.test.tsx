/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import BoardArtifact from "./board-artifact";
import { download_href } from "@cocalc/frontend/project/utils";
import { boardHistoryActions } from "@cocalc/util/board/history-unloadable";
import { boardFrameUrl, isBoardPath } from "./board-artifact-frame";

const readFile = jest.fn();
const stat = jest.fn();
const open_file = jest.fn().mockResolvedValue(undefined);
const boardOpen = jest.fn();
// the project's filesystem, with boardOpen only where a test gives it one
let withBoardOpen = false;
const actions = {
  fs: () =>
    withBoardOpen ? { stat, readFile, boardOpen } : { stat, readFile },
  open_file,
};
const PROJECT_ID = "00000000-1000-4000-8000-000000000000";
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions, project_id: PROJECT_ID }),
}));
const alertMessage = jest.fn();
jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: (opts) => alertMessage(opts),
}));

const FRAME = "https://sagebrush.test/frame/board/";
const PATH = "/home/user/overnight.board.json";
const TITLE = "Sagebrush board: overnight.board.json";
const TEXT = '{"format":"sagebrush-board","version":1}';
const READY = { sagebrush: "ready", version: 1 };

// The frame is mounted once the file has been read.
function watch(frame: HTMLIFrameElement) {
  const posted = jest.fn();
  frame.contentWindow!.postMessage = posted;
  return posted;
}

async function renderBoard() {
  render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
  const frame = (await screen.findByTitle(TITLE)) as HTMLIFrameElement;
  await screen.findByText("Current saved board");
  return { frame, posted: watch(frame) };
}

function fromFrame(frame: HTMLIFrameElement | Window | null, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        source: (frame instanceof HTMLIFrameElement
          ? frame.contentWindow
          : frame) as Window,
      }),
    );
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  withBoardOpen = false;
  localStorage.clear();
  stat.mockResolvedValue({ size: 100 });
  readFile.mockResolvedValue(TEXT);
});

test("the frame is sandboxed and loads Sagebrush's frame page", async () => {
  const { frame } = await renderBoard();
  expect(frame.getAttribute("src")).toBe(FRAME);
  expect(frame.getAttribute("sandbox")).toBe(
    "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads",
  );
  expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
});

test("says which site receives the board", async () => {
  await renderBoard();
  expect(
    screen.getByText(
      /Runs on sagebrush\.test in a sandboxed frame: showing it sends sagebrush\.test this file's complete text and name/,
    ),
  ).toBeInTheDocument();
});

test("posts the saved board when the frame is ready", async () => {
  const { frame, posted } = await renderBoard();
  expect(readFile).toHaveBeenCalledWith(PATH);
  // Nothing is posted before the frame says it listens.
  expect(posted).not.toHaveBeenCalled();
  fromFrame(frame, READY);
  expect(posted).toHaveBeenCalledWith(
    {
      sagebrush: "board",
      version: 1,
      text: TEXT,
      name: "overnight.board.json",
    },
    "*",
  );
});

test("decodes a file read as bytes", async () => {
  readFile.mockResolvedValue(Buffer.from('{"title":"Größe"}'));
  const { frame, posted } = await renderBoard();
  fromFrame(frame, READY);
  expect(posted.mock.calls[0][0].text).toBe('{"title":"Größe"}');
});

test("ignores messages from any other window", async () => {
  const { posted } = await renderBoard();
  fromFrame(window, READY);
  fromFrame(null, READY);
  fromFrame(window, { sagebrush: "error", version: 1, message: "spoofed" });
  expect(posted).not.toHaveBeenCalled();
  expect(screen.queryByText("spoofed")).toBeNull();
});

test("ignores other versions and malformed messages", async () => {
  const { frame, posted } = await renderBoard();
  fromFrame(frame, { sagebrush: "ready", version: 2 });
  fromFrame(frame, "ready");
  fromFrame(frame, null);
  expect(posted).not.toHaveBeenCalled();
});

test("shows the frame's error", async () => {
  const { frame } = await renderBoard();
  fromFrame(frame, READY);
  fromFrame(frame, { sagebrush: "error", version: 1, message: "not a board" });
  expect(
    screen.getByText("Sagebrush could not show this board"),
  ).toBeInTheDocument();
  expect(screen.getByText("not a board")).toBeInTheDocument();
});

test("a later document in the same frame gets nothing", async () => {
  // A window object keeps its identity when its frame navigates, so a
  // replacement document passes the source check. It must not get the board.
  const { frame, posted } = await renderBoard();
  fromFrame(frame, READY);
  expect(posted).toHaveBeenCalledTimes(1);
  fromFrame(frame, READY);
  fromFrame(frame, READY);
  expect(posted).toHaveBeenCalledTimes(1);
});

test("Refresh reads the file again and posts it to a new frame", async () => {
  const { frame, posted } = await renderBoard();
  fromFrame(frame, READY);
  readFile.mockResolvedValue('{"format":"sagebrush-board","version":1,"x":2}');
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  const second = await waitFor(() => {
    const f = screen.getByTitle(TITLE) as HTMLIFrameElement;
    expect(f).not.toBe(frame);
    return f;
  });
  await screen.findByText("Current saved board");
  const posted2 = watch(second);
  fromFrame(second, READY);
  expect(posted2).toHaveBeenCalledTimes(1);
  expect(posted2.mock.calls[0][0].text).toContain('"x":2');
  expect(posted).toHaveBeenCalledTimes(1);
});

test("refuses a board over the preview limit without reading it", async () => {
  stat.mockResolvedValue({ size: 17 * 1024 * 1024 });
  render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
  expect(
    await screen.findByText(/exceeds the 16 MiB preview limit/),
  ).toBeInTheDocument();
  expect(screen.queryByTitle(TITLE)).toBeNull();
  expect(readFile).not.toHaveBeenCalled();
});

test("refuses a board that grew past the limit after the size check", async () => {
  readFile.mockResolvedValue("x".repeat(16 * 1024 * 1024 + 1));
  render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
  expect(
    await screen.findByText(/exceeds the 16 MiB preview limit/),
  ).toBeInTheDocument();
  expect(screen.queryByTitle(TITLE)).toBeNull();
});

test("keeps Open in project", async () => {
  await renderBoard();
  fireEvent.click(screen.getByRole("button", { name: "Open in project" }));
  expect(open_file).toHaveBeenCalledWith({ path: PATH });
});

test("frame URLs and board paths", () => {
  expect(boardFrameUrl("https://sagebrush.space")).toBe(
    "https://sagebrush.space/frame/board/",
  );
  expect(boardFrameUrl("https://dev.sagebrush.space/anything?x=1")).toBe(
    "https://dev.sagebrush.space/frame/board/",
  );
  // http only for this computer (development)
  expect(boardFrameUrl("http://localhost:8907")).toBe(
    "http://localhost:8907/frame/board/",
  );
  expect(boardFrameUrl("http://127.0.0.1:8907")).toBe(
    "http://127.0.0.1:8907/frame/board/",
  );
  expect(boardFrameUrl("http://sagebrush.space")).toBeUndefined();
  expect(boardFrameUrl("")).toBeUndefined();
  expect(boardFrameUrl("javascript:alert(1)")).toBeUndefined();
  expect(boardFrameUrl("not a url")).toBeUndefined();
  expect(isBoardPath("/a/b/Plan.Board.JSON")).toBe(true);
  expect(isBoardPath("/a/b/plan.json")).toBe(false);
});

// The board's host (boardOpen; bounded history plan H1b-4, CORR-H1B4-1):
// every state in which the board can't be edited shows its way out.
describe("what the board's host answers", () => {
  const SYNC = "/home/user/.overnight.board.json.sage-board";
  const DOCS = "/docs/files/history-unloadable";

  beforeEach(() => {
    withBoardOpen = true;
  });

  const unloadable = (cause: any, message = "why") => ({
    path: PATH,
    syncdbPath: SYNC,
    state: "history-unloadable",
    cause,
    message,
    actions: boardHistoryActions(cause),
    docs: "files/history-unloadable",
  });

  async function panel() {
    render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
    return await screen.findByRole("alert", { name: "Ways to this board" });
  }

  const buttons = (alert: HTMLElement) =>
    Array.from(alert.querySelectorAll("button, a")).map(
      (b) => b.textContent ?? "",
    );

  test("while the host does not edit boards (ENOSYS), the card is exactly the saved-file view", async () => {
    boardOpen.mockRejectedValue(
      Object.assign(Error("boards are not implemented"), { code: "ENOSYS" }),
    );
    const { frame, posted } = await renderBoard();
    await waitFor(() => expect(boardOpen).toHaveBeenCalledWith(PATH));
    expect(
      screen.queryByRole("alert", { name: "Ways to this board" }),
    ).toBeNull();
    expect(alertMessage).not.toHaveBeenCalled();
    fromFrame(frame, READY);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  for (const cause of [
    "file-too-large",
    "file-invalid",
    "deadline",
    "failed",
    "reset-unknown",
  ]) {
    test(`${cause}: Open as text, Download, Retry and the docs page`, async () => {
      boardOpen.mockResolvedValue(unloadable(cause, `because ${cause}`));
      const alert = await panel();
      expect(alert).toHaveTextContent(`because ${cause}`);
      expect(buttons(alert)).toEqual([
        "Open the saved file as text",
        "Download the file",
        "Retry",
        "What to do when a board's history can't be loaded",
      ]);
      if (cause == "reset-unknown") {
        expect(alert).toHaveTextContent(
          "The board's history may already have been rebuilt",
        );
      }
      // Download: the project's streaming download of the file
      const download = screen.getByRole("link", { name: "Download the file" });
      expect(download.getAttribute("href")!.replace(/ts=\d+/, "ts=0")).toBe(
        download_href(PROJECT_ID, PATH).replace(/ts=\d+/, "ts=0"),
      );
      expect(download.getAttribute("href")).toMatch(
        new RegExp(
          `/${PROJECT_ID}/files/home/user/overnight\\.board\\.json\\?download&ts=`,
        ),
      );
      // Open as text: the JSON editor, a separate document
      fireEvent.click(
        screen.getByRole("button", { name: "Open the saved file as text" }),
      );
      expect(open_file).toHaveBeenCalledWith({ path: PATH, ext: "json" });
      expect(
        screen.getByRole("link", {
          name: "What to do when a board's history can't be loaded",
        }),
      ).toHaveAttribute("href", DOCS);
    });
  }

  test("busy: Retry only (and the docs page)", async () => {
    boardOpen.mockResolvedValue(unloadable("busy"));
    expect(buttons(await panel())).toEqual([
      "Retry",
      "What to do when a board's history can't be loaded",
    ]);
  });

  test("the file is missing: Restore (the docs page), Retry, no download", async () => {
    boardOpen.mockResolvedValue({
      path: PATH,
      syncdbPath: SYNC,
      state: "missing",
      actions: ["restore", "retry"],
      docs: "files/history-unloadable",
    });
    readFile.mockRejectedValue(
      Object.assign(Error("ENOENT"), { code: "ENOENT" }),
    );
    stat.mockRejectedValue(Object.assign(Error("ENOENT"), { code: "ENOENT" }));
    const alert = await panel();
    expect(alert).toHaveTextContent("The board's file is missing");
    expect(buttons(alert)).toEqual([
      "Restore the file",
      "Retry",
      "What to do when a board's history can't be loaded",
    ]);
    expect(
      screen.getByRole("link", { name: "Restore the file" }),
    ).toHaveAttribute("href", DOCS);
    expect(screen.queryByText("Download the file")).toBeNull();
  });

  test("over the host's limit (too-large): Open as text, Download, Retry", async () => {
    boardOpen.mockResolvedValue({
      path: PATH,
      syncdbPath: SYNC,
      state: "too-large",
      bytes: 5 * 1024 * 1024,
      message: "the board is 5242880 bytes",
      actions: ["open-as-text", "download", "retry"],
      docs: "files/history-unloadable",
    });
    const alert = await panel();
    expect(alert).toHaveTextContent("The board is too large to edit here");
    expect(buttons(alert)).toEqual([
      "Open the saved file as text",
      "Download the file",
      "Retry",
      "What to do when a board's history can't be loaded",
    ]);
  });

  test("Retry asks the host again, and shows the board once it opens", async () => {
    boardOpen.mockResolvedValueOnce(unloadable("deadline"));
    boardOpen.mockResolvedValueOnce({
      path: PATH,
      syncdbPath: SYNC,
      state: "ok",
      bytes: 100,
    });
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(boardOpen).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByRole("alert", { name: "Ways to this board" }),
      ).toBeNull(),
    );
    expect(await screen.findByTitle(TITLE)).toBeInTheDocument();
  });

  test("a rebuilt board: a notice that stays until dismissed, once per history epoch", async () => {
    const rebuilt = (history_epoch: number) => ({
      path: PATH,
      syncdbPath: SYNC,
      state: "ok",
      bytes: 100,
      recovered: { reason: "board-file", time: 1, history_epoch },
    });
    boardOpen.mockResolvedValue(rebuilt(3));
    const first = render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
    await waitFor(() => expect(alertMessage).toHaveBeenCalledTimes(1));
    expect(alertMessage).toHaveBeenCalledWith({
      type: "info",
      title: "Board rebuilt from its saved file",
      message: `The edit history of ${PATH} could not be loaded. It was archived, and the board was rebuilt from its saved file; edits not yet saved to the file may be missing.`,
      block: true,
    });
    expect(
      screen.queryByRole("alert", { name: "Ways to this board" }),
    ).toBeNull();
    first.unmount();
    // the same epoch, shown again: not told again
    const second = render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
    await waitFor(() => expect(boardOpen).toHaveBeenCalledTimes(2));
    await screen.findByTitle(TITLE);
    expect(alertMessage).toHaveBeenCalledTimes(1);
    second.unmount();
    // a later rebuild is told
    boardOpen.mockResolvedValue(rebuilt(4));
    render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
    await waitFor(() => expect(alertMessage).toHaveBeenCalledTimes(2));
  });
});
