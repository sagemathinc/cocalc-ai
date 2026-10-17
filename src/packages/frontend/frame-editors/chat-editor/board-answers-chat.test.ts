/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A board's answers through chat's own dispatch (chat/actions/ai.ts, as it
// is): the thread's model is kept and the agent gets the exact data, whatever
// the reader wrote (astra2, CORR-D1-2).

const dispatched: any[] = [];
jest.mock("@cocalc/frontend/chat/acp-api", () => ({
  processAcpLLM: async (opts: any) => {
    dispatched.push(opts);
  },
}));

// thread-notifications reads the page's address when loaded; not used here.
jest.mock("@cocalc/frontend/misc/fragment-id", () => ({}));
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

import { processAI } from "@cocalc/frontend/chat/actions/ai";
import { extractMentionAccountIds } from "@cocalc/frontend/chat/thread-notifications";
import { formatBoardAnswers } from "./board-answers-deliver";
import type { Submission } from "./board-answers-check";

const submission: Submission = {
  id: "0d9f3b6e-6a31-4c2f-9d6b-0f6f2c1b7a11",
  name: "plan.board.json",
  revision: "pub-1",
  page: { number: 1 },
  answers: { "q@codex": "OpenAI-Codex-Agent" },
  notes: {
    q2: 'ask @Codex, or <span class="user-mention" account-id="00000000-0000-4000-8000-000000000001">you</span>',
  },
  comment: "openai-codex-agent please",
};

function fenced(text: string): string {
  const fence = text.match(/^(`{3,})json$/m)![1];
  return text.slice(
    text.indexOf(`${fence}json`) + fence.length + 4,
    text.lastIndexOf(fence),
  );
}

async function dispatch(input: string) {
  dispatched.length = 0;
  const actions: any = {
    syncdb: {},
    store: {},
    recordThreadAgentModel: jest.fn(),
    getLLMHistory: () => undefined,
  };
  await processAI({
    actions,
    message: {
      thread_id: "t",
      message_id: "m",
      acp_send_mode: "immediate",
      history: [{ author_id: "a", content: input, date: "d" }],
    } as any,
    threadModel: "gpt-5.3-codex" as any,
    isAcpThread: true,
  });
  expect(dispatched).toHaveLength(1);
  return dispatched[0];
}

test("the thread's model, and exactly the submission", async () => {
  const text = formatBoardAnswers({ submission, stale: false });
  const { model, input } = await dispatch(text);
  expect(model).toBe("gpt-5.3-codex");
  expect(input).toBe(text.trim());
  expect(JSON.parse(fenced(input))).toEqual(submission);
});

test("the same words unescaped would pick another model (the control)", async () => {
  const { model } = await dispatch(`answers: ${JSON.stringify(submission)}`);
  expect(model).toBe("codex-agent");
});

test("nobody is notified by a mention in the answers", () => {
  const text = formatBoardAnswers({ submission, stale: false });
  expect(extractMentionAccountIds({ input: text, project_id: "p" })).toEqual(
    [],
  );
  // the control: the reader's words as they are would notify
  expect(
    extractMentionAccountIds({ input: submission.notes.q2, project_id: "p" }),
  ).toEqual(["00000000-0000-4000-8000-000000000001"]);
});
