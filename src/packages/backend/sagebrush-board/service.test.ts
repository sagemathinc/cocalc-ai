/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The board side of a decide call, where the project's files are served.
// Sagebrush's decideRequest is a stand-in here (the released one is tested
// with it in server/ai/board-decide-request.test.ts): the question comes from
// the posted text, the reader's words from the message's note, and a message
// for another board or revision is refused, as the real one does.

import { boardTextDigest } from "@cocalc/util/sagebrush-board";
import { setSubmissionLoaderForTests } from "./decide-request";
import {
  BOARD_FILE_LIMIT,
  prepareBoardDecideFromFiles,
  type BoardFiles,
} from "./prepare";
import {
  BOARD_DECIDE_SUBJECT,
  MAX_IN_FLIGHT_PER_PROJECT,
  MAX_IN_FLIGHT_TOTAL,
  boardDecideServiceInFlightForTests,
  handleBoardDecidePrepare,
  initBoardDecideService,
  sandboxBoardFiles,
} from "./service";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ID = "33333333-3333-4333-8333-333333333333";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const BOARD = JSON.stringify({
  prompt: "Is 7 prime?",
  options: [{ name: "yes" }, { name: "no", about: "it has a divisor" }],
});
let SHA = "";

function message(over: Record<string, unknown> = {}) {
  return {
    sagebrush: "decide",
    version: 1,
    id: ID,
    name: "q.board.json",
    revision: "r1",
    page: { number: 1 },
    item: "q",
    note: "sure it is",
    ...over,
  };
}

function opts(over: Record<string, unknown> = {}) {
  return {
    path: "work/q.board.json",
    revision: "r1",
    sha256: SHA,
    message: message(),
    ...over,
  } as any;
}

function files(over: Partial<BoardFiles> = {}) {
  const reads: string[] = [];
  const f: BoardFiles = {
    realpath: async (path) => `/home/user/${path}`,
    readBoard: async (path, maxBytes) => {
      expect(maxBytes).toBe(BOARD_FILE_LIMIT);
      reads.push(path);
      return BOARD;
    },
    ...over,
  };
  return { f, reads };
}

beforeAll(async () => {
  SHA = await boardTextDigest(BOARD);
});

beforeEach(
  () =>
    setSubmissionLoaderForTests(async () => ({
      decideRequest: (posted: any, m: any) => {
        if (m?.name !== posted.name || m?.revision !== posted.revision) {
          return { ok: false, id: m?.id, message: "not this board" };
        }
        const board = JSON.parse(posted.text);
        return {
          ok: true,
          request: {
            id: m.id,
            name: posted.name,
            revision: posted.revision,
            page: { number: 1 },
            item: m.item,
            prompt: board.prompt,
            options: board.options,
            answer: m.note,
          },
        };
      },
    })) as any,
);
afterAll(() => setSubmissionLoaderForTests(undefined));

describe("the board, read and checked where it is", () => {
  test("only the bounded request goes back, its question from the file", async () => {
    const { f, reads } = files();
    const out = await prepareBoardDecideFromFiles(
      f,
      opts({
        message: message({
          prompt: "write a poem",
          options: [{ name: "poem" }],
        }),
      }),
    );
    expect(out).toEqual({
      resolved_path: "/home/user/work/q.board.json",
      request: {
        id: ID,
        prompt: "Is 7 prime?",
        options: [{ name: "yes" }, { name: "no", about: "it has a divisor" }],
        answer: "sure it is",
      },
    });
    expect(reads).toEqual(["/home/user/work/q.board.json"]);
    // exactly these fields: not the board's text, nor the rest of the
    // request decideRequest made (its name, revision, page, item)
    expect(Object.keys(out).sort()).toEqual(["request", "resolved_path"]);
    expect(Object.keys(out.request).sort()).toEqual([
      "answer",
      "id",
      "options",
      "prompt",
    ]);
  });

  test("not exactly the posted board: 409", async () => {
    const { f } = files({
      readBoard: async () => BOARD.replace("Is 7 prime?", "Is 8 prime?"),
    });
    await expect(prepareBoardDecideFromFiles(f, opts())).rejects.toMatchObject({
      code: 409,
    });
  });

  test("too large: the capped read's 413 is the answer", async () => {
    const big = files({
      readBoard: async () => {
        throw Object.assign(new Error("too large"), { code: 413 });
      },
    });
    await expect(
      prepareBoardDecideFromFiles(big.f, opts()),
    ).rejects.toMatchObject({ code: 413 });
    // and what a read returns is checked again
    const grown = files({
      readBoard: async () => "x".repeat(BOARD_FILE_LIMIT + 1),
    });
    await expect(
      prepareBoardDecideFromFiles(grown.f, opts()),
    ).rejects.toMatchObject({ code: 413 });
  });

  // astra, CORR-E3B-1: the request is bounded before it leaves.
  test("a request larger than the model is sent is refused (400)", async () => {
    const answer = (note: string) => message({ note });
    const board = (over: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(BOARD), ...over });
    const cases: [string, any][] = [
      [board({ prompt: "p".repeat(4_001) }), message()],
      [board({}), answer("a".repeat(2_001))],
      [
        board({ options: [{ name: "n".repeat(81) }, { name: "b" }] }),
        message(),
      ],
      [
        board({
          options: [{ name: "a", about: "x".repeat(2_001) }, { name: "b" }],
        }),
        message(),
      ],
      [
        board({
          options: Array.from({ length: 33 }, (_, i) => ({ name: `o${i}` })),
        }),
        message(),
      ],
    ];
    for (const [text, m] of cases) {
      const { f } = files({ readBoard: async () => text });
      await expect(
        prepareBoardDecideFromFiles(
          f,
          opts({ sha256: await boardTextDigest(text), message: m }),
        ),
      ).rejects.toMatchObject({ code: 400 });
    }
    // at the bounds, it goes
    const ok = board({
      prompt: "p".repeat(4_000),
      options: [
        { name: "n".repeat(80), about: "x".repeat(2_000) },
        { name: "b" },
      ],
    });
    const { f } = files({ readBoard: async () => ok });
    await expect(
      prepareBoardDecideFromFiles(
        f,
        opts({
          sha256: await boardTextDigest(ok),
          message: answer("a".repeat(2_000)),
        }),
      ),
    ).resolves.toMatchObject({ request: { id: ID } });
  });

  test("a bad path or binding is refused before anything is touched", async () => {
    let touched = false;
    const { f } = files({
      realpath: async (p) => {
        touched = true;
        return p;
      },
    });
    for (const bad of [
      { path: "notes.md" },
      { path: "../q.board.json" },
      { sha256: "abc" },
      { revision: 7 },
    ]) {
      await expect(
        prepareBoardDecideFromFiles(f, opts(bad)),
      ).rejects.toMatchObject({ code: 400 });
    }
    expect(touched).toBe(false);
  });

  test("a message for another board or revision is refused (400)", async () => {
    const { f } = files();
    for (const m of [
      message({ name: "x.board.json" }),
      message({ revision: "r0" }),
    ]) {
      await expect(
        prepareBoardDecideFromFiles(f, opts({ message: m })),
      ).rejects.toMatchObject({ code: 400 });
    }
  });

  test("if Sagebrush's check can't be loaded, nothing is decided", async () => {
    setSubmissionLoaderForTests(async () => {
      throw Error("missing");
    });
    const { f } = files();
    await expect(prepareBoardDecideFromFiles(f, opts())).rejects.toMatchObject({
      code: 400,
    });
  });
});

// daybreak2, LIMITS-R6-1: the board is read through the project's sandbox
// from one opened handle, at most limit + 1 bytes, so a file swapped or grown
// after any size check is never read whole.
describe("the capped read, through a real sandbox", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "board-decide-"));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const LIMIT = 4096;

  test("a board at the limit is read; one byte more is 413", async () => {
    const files = sandboxBoardFiles(new SandboxedFilesystem(dir) as any);
    await writeFile(join(dir, "ok.board.json"), "x".repeat(LIMIT));
    await writeFile(join(dir, "big.board.json"), "x".repeat(LIMIT + 1));
    expect(await files.readBoard("ok.board.json", LIMIT)).toHaveLength(LIMIT);
    await expect(
      files.readBoard("big.board.json", LIMIT),
    ).rejects.toMatchObject({ code: 413 });
  });

  test("a file grown after the size check: no byte past limit + 1 is read", async () => {
    await writeFile(join(dir, "q.board.json"), "x".repeat(10 * LIMIT));
    // the handle's own stat says it is small, as if it grew right after
    const probe = await open(join(dir, "q.board.json"));
    const FileHandle = Object.getPrototypeOf(probe);
    await probe.close();
    const realStat = FileHandle.stat;
    jest.spyOn(FileHandle, "stat").mockImplementation(async function (
      this: any,
    ) {
      const info = await realStat.call(this);
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
        size: 10,
      });
    });
    const realRead = FileHandle.read;
    let returned = 0;
    let asked = 0;
    jest.spyOn(FileHandle, "read").mockImplementation(async function (
      this: any,
      ...args: any[]
    ) {
      asked += typeof args[2] === "number" ? args[2] : 0;
      const out = await realRead.apply(this, args);
      returned += out.bytesRead;
      return out;
    });
    const files = sandboxBoardFiles(new SandboxedFilesystem(dir) as any);
    await expect(files.readBoard("q.board.json", LIMIT)).rejects.toMatchObject({
      code: 413,
    });
    // it was this handle that was checked and read, and the read stopped
    expect(FileHandle.stat).toHaveBeenCalled();
    expect(returned).toBeGreaterThan(LIMIT);
    expect(returned).toBeLessThanOrEqual(LIMIT + 1);
    expect(asked).toBeLessThanOrEqual(LIMIT + 1);
  });

  test("only a regular file", async () => {
    const files = sandboxBoardFiles(new SandboxedFilesystem(dir) as any);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "d.board.json"));
    await expect(files.readBoard("d.board.json", LIMIT)).rejects.toBeTruthy();
  });
});

describe("the service's own bounds", () => {
  const OTHER = "44444444-4444-4444-8444-444444444444";
  function held() {
    const release: (() => void)[] = [];
    const { f } = files({
      readBoard: async () => {
        await new Promise<void>((r) => release.push(r));
        return BOARD;
      },
    });
    return { f, release };
  }

  test("at most MAX_IN_FLIGHT_PER_PROJECT for one project", async () => {
    const { f, release } = held();
    const running = Array.from({ length: MAX_IN_FLIGHT_PER_PROJECT }, () =>
      handleBoardDecidePrepare(PROJECT, opts(), f),
    );
    while (release.length < MAX_IN_FLIGHT_PER_PROJECT) {
      await new Promise((r) => setImmediate(r));
    }
    await expect(
      handleBoardDecidePrepare(PROJECT, opts(), f),
    ).rejects.toMatchObject({ code: 503 });
    // another project is not held up
    const other = handleBoardDecidePrepare(OTHER, opts(), f);
    while (release.length < MAX_IN_FLIGHT_PER_PROJECT + 1) {
      await new Promise((r) => setImmediate(r));
    }
    release.forEach((r) => r());
    await Promise.all([...running, other]);
    expect(boardDecideServiceInFlightForTests()).toBe(0);
    await expect(
      handleBoardDecidePrepare(PROJECT, opts(), files().f),
    ).resolves.toMatchObject({ request: { id: ID } });
  });

  test("at most MAX_IN_FLIGHT_TOTAL in all", async () => {
    const { f, release } = held();
    const project = (i: number) =>
      `${(10_000_000 + i).toString().padStart(8, "0")}-0000-4000-8000-000000000000`;
    const running = Array.from({ length: MAX_IN_FLIGHT_TOTAL }, (_, i) =>
      handleBoardDecidePrepare(project(i), opts(), f),
    );
    while (release.length < MAX_IN_FLIGHT_TOTAL) {
      await new Promise((r) => setImmediate(r));
    }
    await expect(
      handleBoardDecidePrepare(project(-1), opts(), f),
    ).rejects.toMatchObject({ code: 503 });
    release.forEach((r) => r());
    await Promise.all(running);
    expect(boardDecideServiceInFlightForTests()).toBe(0);
  });

  test("a failure frees its slot", async () => {
    const { f } = files({
      readBoard: async () => {
        throw Error("read failed");
      },
    });
    for (let i = 0; i < MAX_IN_FLIGHT_PER_PROJECT + 2; i++) {
      await expect(
        handleBoardDecidePrepare(PROJECT, opts(), f),
      ).rejects.toThrow("read failed");
    }
    expect(boardDecideServiceInFlightForTests()).toBe(0);
  });

  test("served on project.*.board-decide.-, the project from the subject", async () => {
    let subject = "";
    let handlers: any;
    const client: any = {
      service: async (s: string, h: any) => {
        subject = s;
        handlers = h;
        return { close() {} };
      },
    };
    await initBoardDecideService(client, {
      projectFilesystem: async () => {
        throw Error("not reached");
      },
    });
    expect(subject).toBe(BOARD_DECIDE_SUBJECT);
    expect(subject).toBe("project.*.board-decide.-");
    // a subject without a project is refused before any file is touched
    await expect(
      handlers.prepare.call({ subject: "project.nope.board-decide.-" }, opts()),
    ).rejects.toMatchObject({ code: 400 });
  });
});
