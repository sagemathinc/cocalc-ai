/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The release pair: board answers checked by the released Sagebrush check
// (@sagemathinc/sagebrush-board/submission 0.2.0, no stand-in), with the
// `sagebrush` command line of the same release (0.5.0) pinned in the skill.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAnswersChannel } from "./board-answers-channel";
import { checkSubmission } from "./board-answers-check";
import { deliverBoardAnswers } from "./board-answers-deliver";

const BOARD_PACKAGE = "0.2.0";
const CLI = "0.5.0";
const ID = "0d9f3b6e-6a31-4c2f-9d6b-0f6f2c1b7a11";

const PACKAGES = join(__dirname, "..", "..", "..");
const readJson = (...path: string[]) =>
  JSON.parse(readFileSync(join(PACKAGES, ...path), "utf8"));

const BOARD = JSON.stringify({
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
    { id: "why", kind: "ask", input: "text", title: "Why?" },
  ],
});
const POSTED = { text: BOARD, name: "plan.board.json", revision: "r1" };

function answers(over: Record<string, unknown> = {}) {
  return {
    sagebrush: "answers",
    version: 1,
    id: ID,
    name: "plan.board.json",
    revision: "r1",
    page: { number: 1 },
    answers: { pick: "a", why: "ask @codex, it's cheaper" },
    notes: { pick: 'B is <span class="user-mention">risky</span>' },
    comment: "",
    ...over,
  };
}

test("one release: the package pinned exactly, installed, and paired with the CLI", () => {
  // the card (frontend) and the board's reader (backend, where the
  // project's files are served); the hub (server) reads no board
  for (const pkg of ["frontend", "backend"]) {
    expect(
      readJson(pkg, "package.json").dependencies[
        "@sagemathinc/sagebrush-board"
      ],
    ).toBe(BOARD_PACKAGE);
  }
  expect(
    readJson("server", "package.json").dependencies[
      "@sagemathinc/sagebrush-board"
    ],
  ).toBeUndefined();
  const installed = readJson(
    "frontend",
    "node_modules",
    "@sagemathinc",
    "sagebrush-board",
    "package.json",
  );
  expect(installed.version).toBe(BOARD_PACKAGE);
  expect(installed.peerDependencies.sagebrush).toBe(`^${CLI}`);
  const skill = readFileSync(
    join(PACKAGES, "cli", "skills", "cocalc", "SKILL.md"),
    "utf8",
  );
  expect(skill).toContain(`npm pack sagebrush@${CLI} `);
  expect(skill).toContain(`  sagebrush-${CLI}.tgz" | sha512sum -c`);
  expect(skill).toContain(`tar -xzf sagebrush-${CLI}.tgz`);
});

test("the released check: only what the posted board asks, and nothing else", () => {
  const out = checkSubmission(POSTED, answers({ extra: "dropped" }));
  expect(out).toEqual({
    ok: true,
    submission: {
      id: ID,
      name: "plan.board.json",
      revision: "r1",
      page: { number: 1 },
      answers: { pick: "a", why: "ask @codex, it's cheaper" },
      notes: { pick: 'B is <span class="user-mention">risky</span>' },
      comment: "",
    },
  });
  for (const bad of [
    answers({ answers: { pick: "z" } }), // not one of its options
    answers({ answers: { nope: 1 } }), // no such question
    answers({ revision: "r2" }), // another revision than the card's
    answers({ name: "other.board.json" }),
  ]) {
    expect(checkSubmission(POSTED, bad)).toMatchObject({ ok: false, id: ID });
  }
});

describe("through the channel and the delivery", () => {
  function channel() {
    const sent: any[] = [];
    const port = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage: (m: unknown) => sent.push(m),
      close: () => {},
    };
    const delivered: any[] = [];
    openAnswersChannel({
      port,
      posted: POSTED,
      deliver: async (submission) => {
        delivered.push(submission);
      },
      isCurrentRevision: () => true,
    });
    const send = async (data: unknown) => {
      port.onmessage!({ data } as MessageEvent);
      await new Promise((r) => setTimeout(r, 0));
    };
    return { sent, send, delivered };
  }

  test("a checked submission is delivered as checked, then received", async () => {
    const { sent, send, delivered } = channel();
    await send(answers({ extra: "dropped" }));
    expect(delivered).toEqual([
      (checkSubmission(POSTED, answers()) as any).submission,
    ]);
    expect(sent).toEqual([{ sagebrush: "received", version: 1, id: ID }]);
  });

  test("a refused one is answered in Sagebrush's words, and nothing is delivered", async () => {
    const { sent, send, delivered } = channel();
    await send(answers({ answers: { nope: 1 } }));
    expect(delivered).toEqual([]);
    expect(sent).toEqual([
      expect.objectContaining({ sagebrush: "refused", id: ID }),
    ]);
  });

  test("the agent gets exactly the checked data, inert to chat", async () => {
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      value: require("crypto").webcrypto.subtle,
    });
    const submission = (checkSubmission(POSTED, answers()) as any).submission;
    let input = "";
    const chat = {
      getMessagesInThread: () => [{}],
      getMessageById: () => undefined,
      reserveChatSendIdentity: () => ({
        date: "2026-10-17T08:00:00.000Z",
        message_id: "x",
        thread_id: "t",
      }),
      sendChat: (opts: any) => {
        input = opts.input;
        return opts.chatIdentity.date;
      },
      dispatchChatMessage: async () => {},
      getAcpMessageState: () => "sent",
      syncdb: { save: async () => {} },
    };
    await deliverBoardAnswers({
      chat,
      threadId: "t",
      submission,
      stale: false,
    });
    const fence = input.match(/^(`{3,})json$/m)![1];
    const json = input.slice(
      input.indexOf(`${fence}json`) + fence.length + 4,
      input.lastIndexOf(fence),
    );
    expect(JSON.parse(json)).toEqual(submission);
    expect(input.toLowerCase()).not.toMatch(/@codex|<span/);
  });
});
