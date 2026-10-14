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
import { boardFrameUrl, isBoardPath } from "./board-artifact-frame";

const readFile = jest.fn();
const stat = jest.fn();
const open_file = jest.fn().mockResolvedValue(undefined);
const actions = { fs: () => ({ stat, readFile }), open_file };
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions }),
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
