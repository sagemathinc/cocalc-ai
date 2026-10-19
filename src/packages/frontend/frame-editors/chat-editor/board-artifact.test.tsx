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

// The card reads only with the file service's capped read.
const readRegularFile = jest.fn();
const readFile = jest.fn();
const stat = jest.fn();
const open_file = jest.fn().mockResolvedValue(undefined);
const actions = {
  fs: () => ({ stat, readFile, readRegularFile }),
  open_file,
};
const LIMIT = 16 * 1024 * 1024;
function efbig() {
  return Object.assign(new Error("EFBIG: file exceeds read limit"), {
    code: "EFBIG",
  });
}
const PROJECT = "22222222-2222-4222-8222-222222222222";
let mockProjectId = PROJECT;
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions, project_id: mockProjectId }),
}));
let mockDecideEnabled: boolean | undefined = undefined;
jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useTypedRedux: (store: string, key: string) =>
    store === "customize" && key === "board_decide_enabled"
      ? mockDecideEnabled
      : undefined,
}));
const boardDecide = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { hub: { system: { boardDecide: (o) => boardDecide(o) } } },
  },
}));

const FRAME = "https://sagebrush.test/frame/board/";
const PATH = "/home/user/overnight.board.json";
const TITLE = "Sagebrush board: overnight.board.json";
const TEXT = '{"format":"sagebrush-board","version":1}';
const READY = { sagebrush: "ready", version: 1 };

// jsdom has no crypto.subtle; a secure browser context does.
function withSubtle() {
  const real = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
  beforeAll(() => {
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      value: require("crypto").webcrypto.subtle,
    });
  });
  afterAll(() => {
    if (real) Object.defineProperty(globalThis.crypto, "subtle", real);
    else delete (globalThis.crypto as any).subtle;
  });
}

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
  mockDecideEnabled = undefined;
  mockProjectId = PROJECT;
  stat.mockResolvedValue({ size: 100 });
  readRegularFile.mockResolvedValue(TEXT);
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
  expect(readRegularFile).toHaveBeenCalledWith(PATH, { maxBytes: LIMIT });
  expect(readFile).not.toHaveBeenCalled();
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
  readRegularFile.mockResolvedValue(Buffer.from('{"title":"Größe"}'));
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
  readRegularFile.mockResolvedValue(
    '{"format":"sagebrush-board","version":1,"x":2}',
  );
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

test("refuses a board the file service finds over the preview limit", async () => {
  readRegularFile.mockRejectedValue(efbig());
  render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
  expect(
    await screen.findByText(/exceeds the 16 MiB preview limit/),
  ).toBeInTheDocument();
  expect(screen.queryByTitle(TITLE)).toBeNull();
  expect(readRegularFile).toHaveBeenCalledWith(PATH, { maxBytes: LIMIT });
});

test("a board that grows after a stat is never read in full", async () => {
  // A stat would see the small board; it grows before the read. Only the
  // capped read can refuse it: an uncapped read would return all of it.
  const grown = "x".repeat(LIMIT + 1);
  stat.mockResolvedValue({ size: 100 });
  readFile.mockResolvedValue(grown);
  readRegularFile.mockImplementation(async (_path, { maxBytes }) => {
    if (grown.length > maxBytes) throw efbig();
    return grown;
  });
  render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
  expect(
    await screen.findByText(/exceeds the 16 MiB preview limit/),
  ).toBeInTheDocument();
  expect(screen.queryByTitle(TITLE)).toBeNull();
  expect(readFile).not.toHaveBeenCalled();
});

test("still refuses an over-limit result from the file service", async () => {
  readRegularFile.mockResolvedValue("x".repeat(LIMIT + 1));
  render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
  expect(
    await screen.findByText(/exceeds the 16 MiB preview limit/),
  ).toBeInTheDocument();
  expect(screen.queryByTitle(TITLE)).toBeNull();
});

test("shows any other read error as it is", async () => {
  readRegularFile.mockRejectedValue(
    Object.assign(new Error("capped regular-file reads are not supported"), {
      code: "ENOTSUP",
    }),
  );
  render(<BoardArtifact path={PATH} frameUrl={FRAME} />);
  expect(
    await screen.findByText(/capped regular-file reads are not supported/),
  ).toBeInTheDocument();
  expect(readFile).not.toHaveBeenCalled();
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

describe("the answers bootstrap (board-host-protocol.md)", () => {
  const deliver = jest.fn().mockResolvedValue(undefined);

  // test/setup.js's MessageChannel only carries port2 -> port1; these tests
  // need both directions and close(), as in a browser.
  class TestPort {
    other?: TestPort;
    closed = false;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    postMessage(data: unknown) {
      const to = this.other;
      if (this.closed || !to) return;
      setTimeout(() => {
        if (!to.closed && !this.closed) to.onmessage?.({ data });
      }, 0);
    }
    close() {
      this.closed = true;
    }
  }
  class TestChannel {
    port1 = new TestPort();
    port2 = new TestPort();
    constructor() {
      this.port1.other = this.port2;
      this.port2.other = this.port1;
    }
  }
  const realChannel = (globalThis as any).MessageChannel;
  beforeAll(() => {
    (globalThis as any).MessageChannel = TestChannel;
  });
  afterAll(() => {
    (globalThis as any).MessageChannel = realChannel;
  });

  async function renderAnswering() {
    render(
      <BoardArtifact
        path={PATH}
        frameUrl={FRAME}
        deliverAnswers={deliver}
        revision="pub-1"
      />,
    );
    const frame = (await screen.findByTitle(TITLE)) as HTMLIFrameElement;
    await screen.findByText("Current saved board");
    const nonce = new URL(frame.getAttribute("src")!).hash.replace(
      "#sb-nonce=",
      "",
    );
    return { frame, posted: watch(frame), nonce };
  }

  // The reply on a granted port, if any, within a moment.
  function replyOn(port: any, message: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      port.onmessage = (e) => resolve(e.data);
      port.postMessage(message);
      setTimeout(() => resolve(undefined), 200);
    });
  }
  const SUBMIT = {
    sagebrush: "answers",
    version: 1,
    id: "0d9f3b6e-6a31-4c2f-9d6b-0f6f2c1b7a11",
    name: "overnight.board.json",
    revision: "pub-1",
    page: { number: 1 },
    answers: {},
    notes: {},
    comment: "",
  };

  test("the frame is loaded with a fresh nonce in its fragment", async () => {
    const { frame, nonce } = await renderAnswering();
    expect(frame.getAttribute("src")).toBe(`${FRAME}#sb-nonce=${nonce}`);
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("the first ready with the nonce gets the board, its revision and a port", async () => {
    const { frame, posted, nonce } = await renderAnswering();
    fromFrame(frame, { ...READY, nonce });
    expect(posted).toHaveBeenCalledTimes(1);
    const [message, target, transfer] = posted.mock.calls[0];
    expect(message).toEqual({
      sagebrush: "board",
      version: 1,
      text: TEXT,
      name: "overnight.board.json",
      revision: "pub-1",
    });
    expect(target).toBe("*");
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBeInstanceOf(TestPort);
    // The port answers: Sagebrush's check refuses (this board asks nothing).
    const reply: any = await replyOn(transfer[0], SUBMIT);
    expect(reply).toMatchObject({ sagebrush: "refused", id: SUBMIT.id });
    expect(deliver).not.toHaveBeenCalled();
    fromFrame(frame, { ...READY, nonce }); // a second ready: nothing more
    expect(posted).toHaveBeenCalledTimes(1);
  });

  test("a ready without the nonce gets the board without a port (no Submit)", async () => {
    const { frame, posted } = await renderAnswering();
    fromFrame(frame, { ...READY, nonce: "not-the-nonce" });
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls[0][2]).toBeUndefined();
    expect(posted.mock.calls[0][0]).toEqual({
      sagebrush: "board",
      version: 1,
      text: TEXT,
      name: "overnight.board.json",
    });
  });

  test("a document that replaced the first one gets nothing", async () => {
    const { frame, posted, nonce } = await renderAnswering();
    fireEvent.load(frame);
    fireEvent.load(frame); // a second document in the frame
    fromFrame(frame, { ...READY, nonce });
    expect(posted).not.toHaveBeenCalled();
  });

  test("a second load closes a granted channel", async () => {
    const { frame, posted, nonce } = await renderAnswering();
    fromFrame(frame, { ...READY, nonce });
    fireEvent.load(frame);
    const port = posted.mock.calls[0][2][0];
    expect(await replyOn(port, SUBMIT)).toMatchObject({ sagebrush: "refused" });
    fireEvent.load(frame); // another document: the channel closes
    expect(await replyOn(port, SUBMIT)).toBeUndefined();
  });

  // Codex on #1134: answering is a capability of the view. When it goes
  // (the same card switched to a historical version, or write access lost)
  // the frame that had it is replaced and its port closed; when it comes
  // back, a fresh frame gets a fresh nonce and port.
  describe("the capability to answer, revoked and restored", () => {
    const QBOARD = JSON.stringify({
      format: "sagebrush-board",
      version: 1,
      title: "Plan",
      layout: "column",
      nodes: [
        {
          id: "pick",
          kind: "ask",
          input: "radio",
          title: "Which plan?",
          options: [
            { value: "a", label: "Plan A" },
            { value: "b", label: "Plan B" },
          ],
        },
      ],
    });
    const answers = (id: string) => ({
      sagebrush: "answers",
      version: 1,
      id,
      name: "overnight.board.json",
      revision: "pub-1",
      page: { number: 1 },
      answers: { pick: "a" },
      notes: {},
      comment: "",
    });
    const ids = [
      "1a2b3c4d-0000-4000-8000-000000000001",
      "1a2b3c4d-0000-4000-8000-000000000002",
      "1a2b3c4d-0000-4000-8000-000000000003",
    ];
    beforeEach(() => readRegularFile.mockResolvedValue(QBOARD));
    const card = (answering: boolean) => (
      <BoardArtifact
        path={PATH}
        frameUrl={FRAME}
        deliverAnswers={answering ? deliver : undefined}
        revision="pub-1"
      />
    );
    // The frame now shown, granted its port if it was mounted to answer.
    async function granted() {
      const frame = (await screen.findByTitle(TITLE)) as HTMLIFrameElement;
      await screen.findByText("Current saved board");
      const posted = watch(frame);
      const nonce = new URL(frame.getAttribute("src")!).hash.replace(
        "#sb-nonce=",
        "",
      );
      fromFrame(frame, { ...READY, nonce });
      return { frame, nonce, port: posted.mock.calls[0]?.[2]?.[0] };
    }

    test("current -> historical: the old port is closed and delivers nothing", async () => {
      const view = render(card(true));
      const first = await granted();
      expect(first.port).toBeInstanceOf(TestPort);
      expect(await replyOn(first.port, answers(ids[0]))).toMatchObject({
        sagebrush: "received",
      });
      expect(deliver).toHaveBeenCalledTimes(1);
      view.rerender(card(false));
      // a new frame, mounted without a nonce
      const frame = (await screen.findByTitle(TITLE)) as HTMLIFrameElement;
      expect(frame).not.toBe(first.frame);
      expect(frame.getAttribute("src")).toBe(FRAME);
      // the old document's port is gone: nothing reaches the callback
      expect(await replyOn(first.port, answers(ids[1]))).toBeUndefined();
      expect(deliver).toHaveBeenCalledTimes(1);
      // and the new frame gets the board without a port, even with the old nonce
      const posted = watch(frame);
      fromFrame(frame, { ...READY, nonce: first.nonce });
      expect(posted.mock.calls[0][2]).toBeUndefined();
    });

    test("historical -> current: a fresh frame, nonce and port that deliver", async () => {
      const view = render(card(false));
      const before = (await screen.findByTitle(TITLE)) as HTMLIFrameElement;
      expect(before.getAttribute("src")).toBe(FRAME);
      view.rerender(card(true));
      await waitFor(() =>
        expect(screen.getByTitle(TITLE).getAttribute("src")).toContain(
          "#sb-nonce=",
        ),
      );
      const now = await granted();
      expect(now.frame).not.toBe(before);
      expect(await replyOn(now.port, answers(ids[0]))).toMatchObject({
        sagebrush: "received",
      });
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    // Codex on #1134: an artifact republished to another directory keeps
    // its basename, so its posted name; the card must still decide and
    // deliver for the new file, never the old one. A new project or path
    // is a new read, so a new frame, nonce and port (like Refresh).
    describe("a new project or path, with the same basename", () => {
      withSubtle();
      const MOVED = "/home/user/final/overnight.board.json";
      const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
      const decide = {
        sagebrush: "decide",
        version: 1,
        id: "6b1f0c1e-2d3a-4f5b-8c7d-9e0f1a2b3c4d",
        name: "overnight.board.json",
        revision: "pub-1",
        page: { number: 1 },
        item: "pick",
        note: "the first",
      };
      const at = (path: string) => (
        <BoardArtifact
          path={path}
          frameUrl={FRAME}
          deliverAnswers={deliver}
          revision="pub-1"
        />
      );
      async function replaced(old: HTMLIFrameElement) {
        await waitFor(() => expect(screen.getByTitle(TITLE)).not.toBe(old));
        return await granted();
      }
      beforeEach(() => {
        mockDecideEnabled = true;
        boardDecide.mockResolvedValue({ id: decide.id, option: "a" });
      });

      test("a path change: the old port is closed; decide and deliver use the new path", async () => {
        const view = render(at(PATH));
        const first = await granted();
        expect(first.port).toBeInstanceOf(TestPort);
        view.rerender(at(MOVED));
        const now = await replaced(first.frame);
        expect(readRegularFile).toHaveBeenLastCalledWith(MOVED, {
          maxBytes: LIMIT,
        });
        expect(now.nonce).not.toBe(first.nonce);
        expect(now.port).toBeInstanceOf(TestPort);
        // Nothing reaches either callback through the old port.
        expect(await replyOn(first.port, decide)).toBeUndefined();
        expect(await replyOn(first.port, answers(ids[0]))).toBeUndefined();
        expect(boardDecide).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
        // The new port decides for the new path, and delivers.
        expect(await replyOn(now.port, decide)).toMatchObject({
          sagebrush: "decided",
          option: "a",
        });
        expect(boardDecide).toHaveBeenCalledTimes(1);
        expect(boardDecide.mock.calls[0][0]).toMatchObject({
          project_id: PROJECT,
          path: MOVED,
        });
        expect(await replyOn(now.port, answers(ids[1]))).toMatchObject({
          sagebrush: "received",
        });
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(screen.getAllByTitle(TITLE)).toHaveLength(1);
      });

      test("a project change: the old port is closed; decide uses the new project", async () => {
        const view = render(at(PATH));
        const first = await granted();
        mockProjectId = OTHER_PROJECT;
        view.rerender(at(PATH));
        const now = await replaced(first.frame);
        expect(now.nonce).not.toBe(first.nonce);
        expect(await replyOn(first.port, decide)).toBeUndefined();
        expect(boardDecide).not.toHaveBeenCalled();
        expect(await replyOn(now.port, decide)).toMatchObject({
          sagebrush: "decided",
        });
        expect(boardDecide.mock.calls[0][0]).toMatchObject({
          project_id: OTHER_PROJECT,
          path: PATH,
        });
        expect(await replyOn(now.port, answers(ids[2]))).toMatchObject({
          sagebrush: "received",
        });
        expect(deliver).toHaveBeenCalledTimes(1);
      });
    });

    test("a rapid toggle leaves exactly one live channel", async () => {
      const view = render(card(true));
      const first = await granted();
      view.rerender(card(false));
      view.rerender(card(true));
      view.rerender(card(false));
      view.rerender(card(true));
      await waitFor(() =>
        expect(screen.getByTitle(TITLE)).not.toBe(first.frame),
      );
      const last = await granted();
      expect(last.nonce).not.toBe(first.nonce);
      expect(await replyOn(first.port, answers(ids[0]))).toBeUndefined();
      expect(await replyOn(last.port, answers(ids[1]))).toMatchObject({
        sagebrush: "received",
      });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(screen.getAllByTitle(TITLE)).toHaveLength(1);
    });
  });

  test("without delivery (read-only views) there is no nonce and no port", async () => {
    const { frame, posted } = await renderBoard();
    expect(frame.getAttribute("src")).toBe(FRAME);
    fromFrame(frame, { ...READY, nonce: "anything" });
    expect(posted.mock.calls[0][2]).toBeUndefined();
  });

  // Codex on #1134: a plain-http site (cocalc-star on a LAN) has no
  // crypto.randomUUID; boards still show there, and still take answers.
  describe("without crypto.randomUUID (a plain-http site)", () => {
    const real = Object.getOwnPropertyDescriptor(
      globalThis.crypto,
      "randomUUID",
    );
    beforeAll(() => {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: undefined,
      });
    });
    afterAll(() => {
      if (real) Object.defineProperty(globalThis.crypto, "randomUUID", real);
      else delete (globalThis.crypto as any).randomUUID;
    });

    test("a read-only board still shows", async () => {
      const { frame, posted } = await renderBoard();
      expect(screen.queryByText(/randomUUID/)).toBeNull();
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

    test("a board taking answers still gets its nonce and port", async () => {
      const { frame, posted, nonce } = await renderAnswering();
      expect(nonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      fromFrame(frame, { ...READY, nonce });
      expect(posted.mock.calls[0][2]).toHaveLength(1);
    });
  });

  describe("deciding (board-host-protocol.md, Deciding)", () => {
    withSubtle();
    const DECIDE = {
      sagebrush: "decide",
      version: 1,
      id: "6b1f0c1e-2d3a-4f5b-8c7d-9e0f1a2b3c4d",
      name: "overnight.board.json",
      revision: "pub-1",
      page: { number: 1 },
      item: "q",
      note: "it is prime",
    };
    async function port() {
      const { frame, posted, nonce } = await renderAnswering();
      fromFrame(frame, { ...READY, nonce });
      return posted.mock.calls[0][2][0];
    }

    test("goes only to the hub, with the board this card posted", async () => {
      mockDecideEnabled = true;
      boardDecide.mockResolvedValue({ id: DECIDE.id, option: "prime" });
      const p = await port();
      const forged = {
        ...DECIDE,
        revision: "pub-0",
        prompt: "other",
        options: [{ name: "x" }],
      };
      expect(await replyOn(p, forged)).toEqual({
        sagebrush: "decided",
        version: 1,
        id: DECIDE.id,
        option: "prime",
      });
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(TEXT),
      );
      const sha256 = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      expect(boardDecide).toHaveBeenCalledTimes(1);
      expect(boardDecide.mock.calls[0][0]).toMatchObject({
        project_id: PROJECT,
        path: PATH,
        revision: "pub-1", // the card's, not the message's
        sha256,
        message: forged,
      });
      expect(deliver).not.toHaveBeenCalled();
    });

    test("where the site doesn't check answers, it is refused without a call", async () => {
      const p = await port();
      expect(await replyOn(p, DECIDE)).toMatchObject({
        sagebrush: "refused",
        id: DECIDE.id,
      });
      expect(boardDecide).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });
  });
});
