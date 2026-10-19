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
} from "./service";

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
    stat: async () => ({ size: BOARD.length }),
    readFile: async (path) => {
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
      readFile: async () => BOARD.replace("Is 7 prime?", "Is 8 prime?"),
    });
    await expect(prepareBoardDecideFromFiles(f, opts())).rejects.toMatchObject({
      code: 409,
    });
  });

  test("too large: 413, without reading it; or grown past it since", async () => {
    const big = files({ stat: async () => ({ size: BOARD_FILE_LIMIT + 1 }) });
    await expect(
      prepareBoardDecideFromFiles(big.f, opts()),
    ).rejects.toMatchObject({ code: 413 });
    expect(big.reads).toHaveLength(0);
    const grown = files({
      readFile: async () => "x".repeat(BOARD_FILE_LIMIT + 1),
    });
    await expect(
      prepareBoardDecideFromFiles(grown.f, opts()),
    ).rejects.toMatchObject({ code: 413 });
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

describe("the service's own bounds", () => {
  const OTHER = "44444444-4444-4444-8444-444444444444";
  function held() {
    const release: (() => void)[] = [];
    const { f } = files({
      readFile: async () => {
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
      readFile: async () => {
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
    await initBoardDecideService(client);
    expect(subject).toBe(BOARD_DECIDE_SUBJECT);
    expect(subject).toBe("project.*.board-decide.-");
    // a subject without a project is refused before any file is touched
    await expect(
      handlers.prepare.call({ subject: "project.nope.board-decide.-" }, opts()),
    ).rejects.toMatchObject({ code: 400 });
  });
});
