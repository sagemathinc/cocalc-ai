/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A board's decide requests on the answers channel (Sagebrush's
// web/board-host-protocol.md, "Deciding"): never a submission, never
// delivered, answered only by "decided" or "refused".

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

import {
  BoardAnswersRefusal,
  MAX_DECIDES_PER_CHANNEL,
  openAnswersChannel,
  type DecideOnBoard,
} from "./board-answers-channel";
import { boardDecider } from "./board-decide-card";

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

const ID = "6b1f0c1e-2d3a-4f5b-8c7d-9e0f1a2b3c4d";
const POSTED = { text: "{}", name: "q.board.json", revision: "r1" };

function decideMessage(over: Record<string, unknown> = {}) {
  return {
    sagebrush: "decide",
    version: 1,
    id: ID,
    name: "q.board.json",
    revision: "r1",
    page: { number: 1 },
    item: "q",
    note: "it is prime",
    ...over,
  };
}

function channel(decide?: DecideOnBoard) {
  const sent: any[] = [];
  const port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (m: unknown) => sent.push(m),
    close: jest.fn(),
  };
  const deliver = jest.fn().mockResolvedValue(undefined);
  const ch = openAnswersChannel({
    port,
    posted: POSTED,
    deliver,
    isCurrentRevision: () => true,
    decide,
  });
  const send = (data: unknown) => port.onmessage!({ data } as MessageEvent);
  return { sent, send, deliver, ch };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a decide request goes only to decide, and gets decided", async () => {
  const decide = jest.fn().mockResolvedValue("prime");
  const { sent, send, deliver } = channel(decide);
  send(decideMessage());
  await tick();
  expect(decide).toHaveBeenCalledWith(decideMessage());
  expect(deliver).not.toHaveBeenCalled();
  expect(sent).toEqual([
    { sagebrush: "decided", version: 1, id: ID, option: "prime" },
  ]);
});

test("none fits: decided with null", async () => {
  const { sent, send } = channel(async () => null);
  send(decideMessage());
  await tick();
  expect(sent).toEqual([
    { sagebrush: "decided", version: 1, id: ID, option: null },
  ]);
});

test("without decide, refused; nothing delivered", async () => {
  const { sent, send, deliver } = channel();
  send(decideMessage());
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ sagebrush: "refused", id: ID });
  expect(deliver).not.toHaveBeenCalled();
});

test("without a request id, nothing at all", async () => {
  const decide = jest.fn();
  const { sent, send } = channel(decide);
  for (const id of [undefined, 7, "not-a-uuid"]) send(decideMessage({ id }));
  await tick();
  expect(sent).toEqual([]);
  expect(decide).not.toHaveBeenCalled();
});

test("one request in flight per channel", async () => {
  let finish!: (v: string | null) => void;
  const decide = jest.fn(() => new Promise<string | null>((r) => (finish = r)));
  const { sent, send } = channel(decide);
  send(decideMessage());
  const other = "7c2e1d0f-3e4b-4a6c-9d8e-0f1a2b3c4d5e";
  send(decideMessage({ id: other }));
  await tick();
  expect(decide).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([
    expect.objectContaining({ sagebrush: "refused", id: other }),
  ]);
  finish("prime");
  await tick();
  send(decideMessage({ id: other }));
  await tick();
  expect(decide).toHaveBeenCalledTimes(2);
});

test("at most MAX_DECIDES_PER_CHANNEL requests per channel", async () => {
  const decide = jest.fn().mockResolvedValue(null);
  const { sent, send } = channel(decide);
  for (let i = 0; i < MAX_DECIDES_PER_CHANNEL; i++) {
    send(decideMessage());
    await tick();
  }
  send(decideMessage());
  await tick();
  expect(decide).toHaveBeenCalledTimes(MAX_DECIDES_PER_CHANNEL);
  expect(sent.at(-1)).toMatchObject({ sagebrush: "refused" });
});

test("a refusal in CoCalc's words; any other failure in fixed words", async () => {
  const a = channel(async () => {
    throw new BoardAnswersRefusal("The board changed: reload it.");
  });
  a.send(decideMessage());
  await tick();
  expect(a.sent[0]).toEqual({
    sagebrush: "refused",
    version: 1,
    id: ID,
    message: "The board changed: reload it.",
  });
  const b = channel(async () => {
    throw new Error("secret internal detail");
  });
  b.send(decideMessage());
  await tick();
  expect(b.sent[0].message).not.toContain("secret");
});

test("only an option name or null reaches the frame", async () => {
  for (const bad of [7, "", "x".repeat(81), { name: "x" }]) {
    const { sent, send } = channel(async () => bad as any);
    send(decideMessage());
    await tick();
    expect(sent).toEqual([
      expect.objectContaining({ sagebrush: "refused", id: ID }),
    ]);
  }
});

test("after close, no reply", async () => {
  let finish!: (v: string | null) => void;
  const { sent, send, ch } = channel(
    () => new Promise<string | null>((r) => (finish = r)),
  );
  send(decideMessage());
  ch.close();
  finish("prime");
  await tick();
  expect(sent).toEqual([]);
});

test("answers still go to deliver as before", async () => {
  const decide = jest.fn();
  const { send } = channel(decide);
  send({ sagebrush: "answers", version: 1, id: ID });
  await tick();
  expect(decide).not.toHaveBeenCalled();
});

describe("boardDecider", () => {
  withSubtle();
  // SHA-256 of "{}"
  const SHA =
    "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
  test("sends the card's board and the frame's message", async () => {
    const call = jest.fn().mockResolvedValue({ id: ID, option: "prime" });
    const decide = boardDecider({
      project_id: "p",
      path: "/home/user/q.board.json",
      revision: "r1",
      text: "{}",
      call,
    });
    const m = decideMessage({ revision: "forged" });
    expect(await decide(m)).toBe("prime");
    expect(call).toHaveBeenCalledWith({
      project_id: "p",
      path: "/home/user/q.board.json",
      revision: "r1",
      sha256: SHA,
      message: m,
      timeout: 45_000,
    });
  });

  test("refusals by code, never the error's own text", async () => {
    const decideWith = (err: any) =>
      boardDecider({
        project_id: "p",
        path: "q.board.json",
        revision: null,
        text: "{}",
        call: async () => {
          throw err;
        },
      })(decideMessage());
    await expect(
      decideWith(Object.assign(new Error("x"), { code: 409 })),
    ).rejects.toThrow("The board changed: reload it.");
    const other = decideWith(
      Object.assign(new Error("internal secret"), { code: 500 }),
    );
    await expect(other).rejects.toBeInstanceOf(BoardAnswersRefusal);
    await expect(other).rejects.not.toThrow("internal secret");
  });

  test("an answer for another request is not used", async () => {
    const decide = boardDecider({
      project_id: "p",
      path: "q.board.json",
      revision: null,
      text: "{}",
      call: async () => ({ id: "other", option: "prime" }),
    });
    await expect(decide(decideMessage())).rejects.toThrow();
  });
});

test("without crypto.subtle, refused in CoCalc's words, without a call", async () => {
  const call = jest.fn();
  const real = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: undefined,
  });
  try {
    const decide = boardDecider({
      project_id: "p",
      path: "q.board.json",
      revision: null,
      text: "{}",
      call,
    });
    await expect(decide(decideMessage())).rejects.toBeInstanceOf(
      BoardAnswersRefusal,
    );
    expect(call).not.toHaveBeenCalled();
  } finally {
    if (real) Object.defineProperty(globalThis.crypto, "subtle", real);
    else delete (globalThis.crypto as any).subtle;
  }
});
