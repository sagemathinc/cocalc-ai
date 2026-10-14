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

function renderBoard() {
  render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
  const frame = screen.getByTitle(
    "Sagebrush board: overnight.board.json",
  ) as HTMLIFrameElement;
  const posted = jest.fn();
  frame.contentWindow!.postMessage = posted;
  return { frame, posted };
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
  readFile.mockResolvedValue('{"format":"sagebrush-board","version":1}');
});

test("the frame is sandboxed and loads Sagebrush's frame page", async () => {
  const { frame } = renderBoard();
  await screen.findByText("Current saved board");
  expect(frame.getAttribute("src")).toBe(FRAME);
  expect(frame.getAttribute("sandbox")).toBe(
    "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads",
  );
  expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
});

test("posts the saved board when the frame is ready", async () => {
  const { frame, posted } = renderBoard();
  await screen.findByText("Current saved board");
  expect(readFile).toHaveBeenCalledWith(PATH, "utf8");
  // Nothing is posted before the frame says it listens.
  expect(posted).not.toHaveBeenCalled();
  fromFrame(frame, { sagebrush: "ready", version: 1 });
  expect(posted).toHaveBeenCalledWith(
    {
      sagebrush: "board",
      version: 1,
      text: '{"format":"sagebrush-board","version":1}',
      name: "overnight.board.json",
    },
    "*",
  );
});

test("ignores messages from any other window", async () => {
  const { posted } = renderBoard();
  await screen.findByText("Current saved board");
  fromFrame(window, { sagebrush: "ready", version: 1 });
  fromFrame(null, { sagebrush: "ready", version: 1 });
  fromFrame(window, { sagebrush: "error", version: 1, message: "spoofed" });
  expect(posted).not.toHaveBeenCalled();
  expect(screen.queryByText("spoofed")).toBeNull();
});

test("ignores other versions and malformed messages", async () => {
  const { frame, posted } = renderBoard();
  await screen.findByText("Current saved board");
  fromFrame(frame, { sagebrush: "ready", version: 2 });
  fromFrame(frame, "ready");
  fromFrame(frame, null);
  expect(posted).not.toHaveBeenCalled();
});

test("shows the frame's error", async () => {
  const { frame } = renderBoard();
  await screen.findByText("Current saved board");
  fromFrame(frame, {
    sagebrush: "error",
    version: 1,
    message: "not a board",
  });
  expect(
    screen.getByText("Sagebrush could not show this board"),
  ).toBeInTheDocument();
  expect(screen.getByText("not a board")).toBeInTheDocument();
});

test("re-posts after Refresh reads a new saved text, and after the frame reloads", async () => {
  const { frame, posted } = renderBoard();
  await screen.findByText("Current saved board");
  fromFrame(frame, { sagebrush: "ready", version: 1 });
  expect(posted).toHaveBeenCalledTimes(1);
  readFile.mockResolvedValue('{"format":"sagebrush-board","version":1,"x":2}');
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  await screen.findByText("Current saved board");
  expect(posted.mock.calls[1][0].text).toContain('"x":2');
  // A reloaded frame says ready again and gets the board again.
  fromFrame(frame, { sagebrush: "ready", version: 1 });
  expect(posted).toHaveBeenCalledTimes(3);
});

test("refuses a board over the preview limit without posting it", async () => {
  stat.mockResolvedValue({ size: 17 * 1024 * 1024 });
  const { frame, posted } = renderBoard();
  expect(
    await screen.findByText(/exceeds the 16 MiB preview limit/),
  ).toBeInTheDocument();
  fromFrame(frame, { sagebrush: "ready", version: 1 });
  expect(posted).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});

test("keeps Open in project", async () => {
  renderBoard();
  await screen.findByText("Current saved board");
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
  expect(boardFrameUrl("")).toBeUndefined();
  expect(boardFrameUrl("javascript:alert(1)")).toBeUndefined();
  expect(boardFrameUrl("not a url")).toBeUndefined();
  expect(isBoardPath("/a/b/Plan.Board.JSON")).toBe(true);
  expect(isBoardPath("/a/b/plan.json")).toBe(false);
});
