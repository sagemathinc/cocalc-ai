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
  within,
} from "@testing-library/react";
import BoardArtifact from "./board-artifact";
import { boardFrameUrl, isBoardPath } from "./board-artifact-frame";
import {
  BOARD_FRAME_HIDDEN_TTL_MS,
  BOARD_FRAME_MAX_HIDDEN,
  BOARD_FRAME_PENDING_MS,
  attachBoardFrame,
  createBoardFrame,
  getBoardFrame,
  layoutBoardFrames,
  resetBoardFrames,
} from "./board-frame-host";
import * as frameHost from "./board-frame-host";

const readFile = jest.fn();
const stat = jest.fn();
const open_file = jest.fn().mockResolvedValue(undefined);
const actions = { fs: () => ({ stat, readFile }), open_file };
// What the project context provides (undefined while it is still loading).
let contextActions: any = actions;
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions: contextActions }),
}));

const FRAME = "https://sagebrush.test/frame/board/";
const PATH = "/home/user/overnight.board.json";
const TITLE = "Sagebrush board: overnight.board.json";
const TEXT = '{"format":"sagebrush-board","version":1}';
const VIEW = "project\nthread\nartifact\nframe-1\nview";

function nonceOf(frame: HTMLIFrameElement): string {
  return new URL(frame.src).hash.replace(/^#sb-nonce=/, "");
}

function ready(frame: HTMLIFrameElement) {
  return { sagebrush: "ready", version: 1, nonce: nonceOf(frame) };
}

function watch(frame: HTMLIFrameElement) {
  const posted = jest.fn();
  frame.contentWindow!.postMessage = posted;
  return posted;
}

function Board({ viewKey = VIEW }: { viewKey?: string }) {
  return <BoardArtifact path={PATH} frameUrl={FRAME} viewKey={viewKey} />;
}

// Renders a view that has no live frame yet, and returns its new frame.
async function renderBoard(viewKey = VIEW) {
  const before = new Set(document.querySelectorAll("iframe"));
  const view = render(<Board viewKey={viewKey} />);
  const frame = await waitFor(() => {
    const created = [...document.querySelectorAll("iframe")].filter(
      (f) => !before.has(f),
    );
    expect(created).toHaveLength(1);
    return created[0] as HTMLIFrameElement;
  });
  await waitFor(() =>
    expect(view.getByText("Current saved board")).toBeInTheDocument(),
  );
  return { view, frame, posted: watch(frame) };
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

function placeholder(container: ParentNode = document): HTMLElement {
  return container.querySelector("[data-board-frame-placeholder]")!;
}

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  contextActions = actions;
  jest.clearAllMocks();
  stat.mockResolvedValue({ size: 100 });
  readFile.mockResolvedValue(TEXT);
});

afterEach(() => {
  resetBoardFrames();
});

test("the frame is sandboxed and loads Sagebrush's frame page with a nonce", async () => {
  const { frame } = await renderBoard();
  expect(frame.src.startsWith(`${FRAME}#sb-nonce=`)).toBe(true);
  expect(nonceOf(frame)).toMatch(/^[0-9a-f-]{36}$/);
  expect(frame.getAttribute("sandbox")).toBe(
    "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads",
  );
  expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
});

test("each frame gets its own nonce", async () => {
  const first = await renderBoard("a");
  readFile.mockResolvedValue(TEXT);
  render(<Board viewKey="b" />);
  await waitFor(() => expect(screen.getAllByTitle(TITLE)).toHaveLength(2));
  const [a, b] = screen.getAllByTitle(TITLE) as HTMLIFrameElement[];
  expect(a).toBe(first.frame);
  expect(nonceOf(a)).not.toBe(nonceOf(b));
});

test("says which site receives the board", async () => {
  await renderBoard();
  expect(
    screen.getByText(
      /Runs on sagebrush\.test in a sandboxed frame: showing it sends sagebrush\.test this file's complete text and name/,
    ),
  ).toBeInTheDocument();
});

test("posts the saved board when the frame is ready with its nonce", async () => {
  const { frame, posted } = await renderBoard();
  expect(readFile).toHaveBeenCalledWith(PATH);
  // Nothing is posted before the frame says it listens.
  expect(posted).not.toHaveBeenCalled();
  fromFrame(frame, ready(frame));
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

test("a ready without the frame's nonce gets nothing", async () => {
  const { frame, posted } = await renderBoard();
  fromFrame(frame, { sagebrush: "ready", version: 1 });
  fromFrame(frame, { sagebrush: "ready", version: 1, nonce: "guess" });
  expect(posted).not.toHaveBeenCalled();
});

test("decodes a file read as bytes", async () => {
  readFile.mockResolvedValue(Buffer.from('{"title":"Größe"}'));
  const { frame, posted } = await renderBoard();
  fromFrame(frame, ready(frame));
  expect(posted.mock.calls[0][0].text).toBe('{"title":"Größe"}');
});

test("ignores messages from any other window", async () => {
  const { frame, posted } = await renderBoard();
  fromFrame(window, ready(frame));
  fromFrame(null, ready(frame));
  fromFrame(window, { sagebrush: "error", version: 1, message: "spoofed" });
  expect(posted).not.toHaveBeenCalled();
  expect(screen.queryByText("spoofed")).toBeNull();
});

test("ignores other versions and malformed messages", async () => {
  const { frame, posted } = await renderBoard();
  fromFrame(frame, { ...ready(frame), version: 2 });
  fromFrame(frame, "ready");
  fromFrame(frame, null);
  expect(posted).not.toHaveBeenCalled();
});

test("shows the frame's error", async () => {
  const { frame } = await renderBoard();
  fromFrame(frame, ready(frame));
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
  fromFrame(frame, ready(frame));
  expect(posted).toHaveBeenCalledTimes(1);
  fromFrame(frame, ready(frame));
  expect(posted).toHaveBeenCalledTimes(1);
});

test("a frame that loaded a second document is answered no more", async () => {
  const { frame, posted } = await renderBoard();
  act(() => {
    frame.dispatchEvent(new Event("load"));
    frame.dispatchEvent(new Event("load"));
  });
  fromFrame(frame, ready(frame));
  expect(posted).not.toHaveBeenCalled();
});

test("a remount with the same view keeps the same live frame", async () => {
  const { view, frame, posted } = await renderBoard();
  fromFrame(frame, ready(frame));
  // Maximizing, a layout change or a tab switch: a new card for the view.
  view.unmount();
  expect(frame.isConnected).toBe(true);
  expect(frame.style.visibility).toBe("hidden");
  render(<Board />);
  await screen.findByText("Current saved board");
  expect(screen.getAllByTitle(TITLE)).toEqual([frame]);
  // Neither read nor posted again: the frame keeps the user's edits.
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(posted).toHaveBeenCalledTimes(1);
});

test("another view gets a frame of its own", async () => {
  const { view, frame } = await renderBoard("one");
  view.unmount();
  render(<Board viewKey="two" />);
  await waitFor(() => expect(screen.getAllByTitle(TITLE)).toHaveLength(2));
  expect(readFile).toHaveBeenCalledTimes(2);
  expect(frame.isConnected).toBe(true);
});

test("Refresh reads the file again and posts it to a new frame", async () => {
  const { frame, posted } = await renderBoard();
  fromFrame(frame, ready(frame));
  readFile.mockResolvedValue('{"format":"sagebrush-board","version":1,"x":2}');
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  const second = await waitFor(() => {
    const f = screen.getByTitle(TITLE) as HTMLIFrameElement;
    expect(f).not.toBe(frame);
    return f;
  });
  await screen.findByText("Current saved board");
  expect(frame.isConnected).toBe(false);
  const posted2 = watch(second);
  fromFrame(second, ready(second));
  expect(posted2).toHaveBeenCalledTimes(1);
  expect(posted2.mock.calls[0][0].text).toContain('"x":2');
  // The old frame's nonce opens nothing in the new one.
  fromFrame(second, ready(frame));
  expect(posted2).toHaveBeenCalledTimes(1);
  expect(posted).toHaveBeenCalledTimes(1);
});

test("lays the frame over the placeholder, clipped to its scrolling ancestors", async () => {
  const view = render(
    <div style={{ overflowY: "auto" }} data-testid="scroller">
      <Board />
    </div>,
  );
  const frame = (await screen.findByTitle(TITLE)) as HTMLIFrameElement;
  await screen.findByText("Current saved board");
  const shown = placeholder(view.container);
  jest
    .spyOn(shown, "getBoundingClientRect")
    .mockReturnValue(rect(10, 50, 400, 300));
  jest
    .spyOn(screen.getByTestId("scroller"), "getBoundingClientRect")
    .mockReturnValue(rect(0, 100, 800, 600));
  act(() => layoutBoardFrames());
  expect(frame.style.visibility).toBe("visible");
  expect(frame.style.left).toBe("10px");
  expect(frame.style.top).toBe("50px");
  expect(frame.style.width).toBe("400px");
  expect(frame.style.height).toBe("300px");
  // The top 50px are scrolled out of the ancestor.
  expect(frame.style.clipPath).toBe("inset(50px 0px 0px 0px)");
});

test("a placeholder under a hidden ancestor (an inactive editor tab) hides the frame", async () => {
  for (const props of [
    { style: { visibility: "hidden" as const } },
    { "aria-hidden": true },
    { inert: true } as any,
  ]) {
    const view = render(
      <div {...props}>
        <Board viewKey={`hidden-${JSON.stringify(props)}`} />
      </div>,
    );
    const frame = (await view.findByTitle(TITLE)) as HTMLIFrameElement;
    await view.findByText("Current saved board");
    jest
      .spyOn(placeholder(view.container), "getBoundingClientRect")
      .mockReturnValue(rect(10, 50, 400, 300));
    act(() => layoutBoardFrames());
    expect(frame.style.visibility).toBe("hidden");
    expect(frame.style.pointerEvents).toBe("none");
    expect(frame.isConnected).toBe(true);
    view.unmount();
    resetBoardFrames();
  }
});

test("keyboard: the placeholder hands focus to the frame, and leaving the frame returns to the card", async () => {
  const view = render(
    <div>
      <button>before</button>
      <Board />
      <button>after</button>
    </div>,
  );
  const frame = (await screen.findByTitle(TITLE)) as HTMLIFrameElement;
  await screen.findByText("Current saved board");
  const shown = placeholder(view.container);
  jest
    .spyOn(shown, "getBoundingClientRect")
    .mockReturnValue(rect(10, 50, 400, 300));
  act(() => layoutBoardFrames());
  expect(shown.tabIndex).toBe(0);
  const [before, after] = [
    frame.previousElementSibling,
    frame.nextElementSibling,
  ] as HTMLElement[];
  // The frame itself is out of the ordinary tab order (entered only through
  // the placeholder), and so are its sentinels unless focus is in it.
  expect(frame.tabIndex).toBe(-1);
  expect(before.tabIndex).toBe(-1);
  expect(after.tabIndex).toBe(-1);
  // Tab onto the placeholder: focus goes into the frame.
  act(() => shown.focus());
  expect(document.activeElement).toBe(frame);
  expect(before.tabIndex).toBe(0);
  expect(after.tabIndex).toBe(0);
  // Tab out of the frame: to the next visible control after the board's
  // place (past the card's empty marks), not to the end of the page.
  act(() => after.focus());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "after" }),
  );
  // Out of the frame: out of the tab order again.
  expect(before.tabIndex).toBe(-1);
  expect(after.tabIndex).toBe(-1);
  // Shift+Tab out of the frame: the card's last control before the board.
  act(() => shown.focus());
  act(() => before.focus());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Refresh" }),
  );
  // With nothing after the board, focus waits at its place (the mark), so
  // the next Tab continues from there.
  view.rerender(
    <div>
      <button>before</button>
      <Board />
    </div>,
  );
  act(() => shown.focus());
  act(() => after.focus());
  expect(document.activeElement).toBe(shown.nextElementSibling);
  expect((document.activeElement as HTMLElement).dataset.boardFrameExit).toBe(
    "",
  );
  // A hidden frame takes no focus, and its sentinels leave the tab order.
  jest.spyOn(shown, "getBoundingClientRect").mockReturnValue(rect(0, 0, 0, 0));
  act(() => layoutBoardFrames());
  expect(before.tabIndex).toBe(-1);
  expect(after.tabIndex).toBe(-1);
  act(() => shown.focus());
  expect(document.activeElement).toBe(shown);
});

test("a placeholder with no size (an inactive tab) hides the frame but keeps it", async () => {
  const { view, frame } = await renderBoard();
  jest
    .spyOn(placeholder(view.container), "getBoundingClientRect")
    .mockReturnValue(rect(0, 0, 0, 0));
  act(() => layoutBoardFrames());
  expect(frame.style.visibility).toBe("hidden");
  expect(frame.isConnected).toBe(true);
});

test("hidden frames beyond the limit are dropped, oldest first", async () => {
  const frames: HTMLIFrameElement[] = [];
  for (let i = 0; i <= BOARD_FRAME_MAX_HIDDEN; i++) {
    const { view, frame } = await renderBoard(`view-${i}`);
    frames.push(frame);
    view.unmount();
  }
  expect(frames[0].isConnected).toBe(false);
  expect(frames.slice(1).every((frame) => frame.isConnected)).toBe(true);
});

test("mounted before the project's actions exist, it loads once they come, and only then", async () => {
  contextActions = undefined;
  const view = render(<Board />);
  await screen.findByText(/Project filesystem unavailable/);
  expect(readFile).not.toHaveBeenCalled();
  contextActions = actions;
  view.rerender(<Board />);
  await screen.findByText("Current saved board");
  expect(screen.getAllByTitle(TITLE)).toHaveLength(1);
  const frame = screen.getByTitle(TITLE);
  // A new actions object later does not read again or replace the frame.
  contextActions = { ...actions };
  view.rerender(<Board />);
  await new Promise((r) => setTimeout(r, 50));
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(screen.getByTitle(TITLE)).toBe(frame);
});

test("a hidden frame is dropped after its time, though nothing else happens", async () => {
  const { view, frame } = await renderBoard();
  jest.useFakeTimers({ now: Date.now() });
  try {
    view.unmount();
    expect(frame.isConnected).toBe(true);
    jest.advanceTimersByTime(BOARD_FRAME_HIDDEN_TTL_MS - 1000);
    expect(frame.isConnected).toBe(true);
    jest.advanceTimersByTime(2000);
    expect(frame.isConnected).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test("a frame shown again before its time is not dropped", async () => {
  const { view, frame } = await renderBoard();
  view.unmount();
  render(<Board />);
  await screen.findByText("Current saved board");
  expect(screen.getAllByTitle(TITLE)).toEqual([frame]);
  jest.useFakeTimers({ now: Date.now() });
  try {
    jest.advanceTimersByTime(2 * BOARD_FRAME_HIDDEN_TTL_MS);
    expect(frame.isConnected).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test("frames created before their cards attach are pending, not dropped to make room", () => {
  jest.useFakeTimers({ now: Date.now() });
  try {
    // More reads finish at once than hidden frames are kept, before any
    // card's layout effect has run.
    const frames = Array.from({ length: BOARD_FRAME_MAX_HIDDEN + 2 }, (_, i) =>
      createBoardFrame({
        key: `pending-${i}`,
        path: PATH,
        frameUrl: FRAME,
        sandbox: "allow-scripts",
        text: TEXT,
        name: "overnight.board.json",
        title: TITLE,
      }),
    );
    expect(frames.every((f) => f.iframe.isConnected)).toBe(true);
    // Never attached: after the grace period they are hidden frames, and the
    // oldest beyond the limit go.
    jest.advanceTimersByTime(BOARD_FRAME_PENDING_MS + 10);
    expect(frames.filter((f) => f.iframe.isConnected)).toHaveLength(
      BOARD_FRAME_MAX_HIDDEN,
    );
  } finally {
    jest.useRealTimers();
  }
});

test("a view the frame isn't shown in is no focus proxy", async () => {
  const first = await renderBoard();
  render(<Board />);
  await waitFor(() =>
    expect(
      first.view.getByText("This board is shown in another view."),
    ).toBeInTheDocument(),
  );
  const older = placeholder(first.view.container);
  expect(older.tabIndex).toBe(-1);
  act(() => older.focus());
  expect(document.activeElement).not.toBe(first.frame);
});

test("shown in two places, the newest has the frame", async () => {
  const first = await renderBoard();
  const second = render(<Board />);
  await waitFor(() =>
    expect(
      first.view.getByText("This board is shown in another view."),
    ).toBeInTheDocument(),
  );
  expect(screen.getAllByTitle(TITLE)).toEqual([first.frame]);
  // In the accessibility tree the frame is at the card showing it: that
  // placeholder owns it, and only that one.
  expect(first.frame.id).toMatch(/^cocalc-board-frame-/);
  expect(placeholder(second.container).getAttribute("aria-owns")).toBe(
    first.frame.id,
  );
  expect(placeholder(first.view.container).hasAttribute("aria-owns")).toBe(
    false,
  );
  second.unmount();
  await waitFor(() =>
    expect(
      first.view.queryByText("This board is shown in another view."),
    ).toBeNull(),
  );
  expect(placeholder(first.view.container).getAttribute("aria-owns")).toBe(
    first.frame.id,
  );
  // Gone from the page: no placeholder owns it.
  const owner = placeholder(first.view.container);
  first.view.unmount();
  expect(owner.hasAttribute("aria-owns")).toBe(false);
});

test("Refresh in one of two places: the other place shows, focuses and hides the new frame", async () => {
  const first = await renderBoard();
  const second = render(<Board />);
  await waitFor(() =>
    expect(
      first.view.getByText("This board is shown in another view."),
    ).toBeInTheDocument(),
  );
  fireEvent.click(
    within(second.container).getByRole("button", { name: "Refresh" }),
  );
  const replaced = await waitFor(() => {
    const f = screen.getByTitle(TITLE) as HTMLIFrameElement;
    expect(f).not.toBe(first.frame);
    return f;
  });
  expect(first.frame.isConnected).toBe(false);
  // The refreshed place goes: the first place has the new frame.
  second.unmount();
  await waitFor(() =>
    expect(
      first.view.queryByText("This board is shown in another view."),
    ).toBeNull(),
  );
  const shown = placeholder(first.view.container);
  jest
    .spyOn(shown, "getBoundingClientRect")
    .mockReturnValue(rect(10, 50, 400, 300));
  act(() => layoutBoardFrames());
  expect(replaced.style.visibility).toBe("visible");
  expect(shown.tabIndex).toBe(0);
  act(() => shown.focus());
  expect(document.activeElement).toBe(replaced);
  // Then the first place goes too: the new frame is hidden, not left over
  // the page at its old position.
  first.view.unmount();
  expect(replaced.isConnected).toBe(true);
  expect(replaced.style.visibility).toBe("hidden");
  expect(replaced.style.pointerEvents).toBe("none");
});

test("shown in two places, the frame falls back to an older place the user can see when the newest is hidden", async () => {
  const first = await renderBoard();
  const second = render(<Board />);
  await waitFor(() =>
    expect(
      first.view.getByText("This board is shown in another view."),
    ).toBeInTheDocument(),
  );
  const older = placeholder(first.view.container);
  const newer = placeholder(second.container);
  jest
    .spyOn(older, "getBoundingClientRect")
    .mockReturnValue(rect(10, 50, 400, 300));
  const newerSize = jest
    .spyOn(newer, "getBoundingClientRect")
    .mockReturnValue(rect(10, 500, 400, 300));
  act(() => layoutBoardFrames());
  expect(first.frame.style.top).toBe("500px");
  expect(newer.getAttribute("aria-owns")).toBe(first.frame.id);
  // The newest place is hidden (its tab deactivated, say): the older,
  // visible one shows the board, is its focus proxy and owns it.
  newerSize.mockReturnValue(rect(0, 0, 0, 0));
  act(() => layoutBoardFrames());
  expect(first.frame.style.visibility).toBe("visible");
  expect(first.frame.style.top).toBe("50px");
  expect(older.getAttribute("aria-owns")).toBe(first.frame.id);
  expect(newer.hasAttribute("aria-owns")).toBe(false);
  await waitFor(() =>
    expect(
      within(first.view.container).queryByText(
        "This board is shown in another view.",
      ),
    ).toBeNull(),
  );
  expect(older.tabIndex).toBe(0);
  expect(
    within(second.container).getByText("This board is shown in another view."),
  ).toBeInTheDocument();
  // Shown again: the newest place has it back.
  newerSize.mockReturnValue(rect(10, 500, 400, 300));
  act(() => layoutBoardFrames());
  expect(first.frame.style.top).toBe("500px");
  expect(newer.getAttribute("aria-owns")).toBe(first.frame.id);
  await waitFor(() =>
    expect(
      within(first.view.container).getByText(
        "This board is shown in another view.",
      ),
    ).toBeInTheDocument(),
  );
});

test("a cached frame retrieved by a remount is claimed until it attaches, not dropped at its time", () => {
  jest.useFakeTimers({ now: Date.now() });
  try {
    const frame = createBoardFrame({
      key: "claimed",
      path: PATH,
      frameUrl: FRAME,
      sandbox: "allow-scripts",
      text: TEXT,
      name: "overnight.board.json",
      title: TITLE,
    });
    // Shown, then hidden: its time starts.
    const element = document.createElement("div");
    document.body.appendChild(element);
    attachBoardFrame(frame, element, () => {})();
    jest.advanceTimersByTime(BOARD_FRAME_HIDDEN_TTL_MS - 100);
    // A remount finds it, just before its time is up...
    expect(getBoardFrame("claimed")).toBe(frame);
    // ...and it is kept past it, while the card attaches.
    jest.advanceTimersByTime(200);
    expect(frame.iframe.isConnected).toBe(true);
    // Never attached: once the claim lapses, it goes as a hidden frame.
    jest.advanceTimersByTime(BOARD_FRAME_PENDING_MS + 10);
    expect(frame.iframe.isConnected).toBe(false);
    element.remove();
  } finally {
    jest.useRealTimers();
  }
});

test("a frame lost before the card could attach it is read again, never a blank card", async () => {
  const { view, frame } = await renderBoard();
  view.unmount();
  const live = jest
    .spyOn(frameHost, "isBoardFrameLive")
    .mockReturnValueOnce(false);
  try {
    render(<Board />);
    await waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    await screen.findByText("Current saved board");
    const shown = screen.getByTitle(TITLE);
    expect(shown).not.toBe(frame);
  } finally {
    live.mockRestore();
  }
});

test("hiding a frame that has focus moves focus to a visible control first", async () => {
  const view = render(
    <div>
      <button>before</button>
      <Board />
      <button>after</button>
    </div>,
  );
  const frame = (await screen.findByTitle(TITLE)) as HTMLIFrameElement;
  await screen.findByText("Current saved board");
  const shown = placeholder(view.container);
  const size = jest
    .spyOn(shown, "getBoundingClientRect")
    .mockReturnValue(rect(10, 50, 400, 300));
  act(() => layoutBoardFrames());
  act(() => shown.focus());
  expect(document.activeElement).toBe(frame);
  // The card is hidden (a tab switch, say): focus leaves the frame for the
  // next visible control, not an invisible board.
  size.mockReturnValue(rect(0, 0, 0, 0));
  act(() => layoutBoardFrames());
  expect(frame.style.visibility).toBe("hidden");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "after" }),
  );
  // And when the card goes while the frame has focus, focus leaves it too.
  size.mockReturnValue(rect(10, 50, 400, 300));
  act(() => layoutBoardFrames());
  act(() => shown.focus());
  expect(document.activeElement).toBe(frame);
  view.unmount();
  expect(document.activeElement).not.toBe(frame);
});

test("refuses a board over the preview limit without reading it", async () => {
  stat.mockResolvedValue({ size: 17 * 1024 * 1024 });
  render(<Board />);
  expect(
    await screen.findByText(/exceeds the 16 MiB preview limit/),
  ).toBeInTheDocument();
  expect(screen.queryByTitle(TITLE)).toBeNull();
  expect(readFile).not.toHaveBeenCalled();
});

test("refuses a board that grew past the limit after the size check", async () => {
  readFile.mockResolvedValue("x".repeat(16 * 1024 * 1024 + 1));
  render(<Board />);
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
