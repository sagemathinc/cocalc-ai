/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { boardDecideForBoard } from "./board-decide-bound";
import { decideRequest } from "./board-decide-request";
import { boardTextDigest } from "@cocalc/util/sagebrush-board";

const ID = "33333333-3333-4333-8333-333333333333";

test("until Sagebrush's checker is published, every request is refused", () => {
  const out = decideRequest(
    { text: "{}", name: "q.board.json", revision: null },
    { sagebrush: "decide", version: 1, id: ID, note: "x" },
  );
  expect(out.ok).toBe(false);
  expect(out).toMatchObject({ id: ID });
  expect(
    decideRequest({ text: "{}" }, { id: "not a uuid" }),
  ).not.toHaveProperty("id");
});

test("the bound call classifies nothing through the stub", async () => {
  let decided = false;
  await expect(
    boardDecideForBoard(
      {
        account_id: "11111111-1111-4111-8111-111111111111",
        project_id: "22222222-2222-4222-8222-222222222222",
        path: "q.board.json",
        revision: null,
        sha256: await boardTextDigest("{}"),
        message: {
          sagebrush: "decide",
          version: 1,
          id: ID,
          name: "q.board.json",
        },
      },
      {
        assertCollab: async () => {},
        realpath: async (_p, path) => path,
        stat: async () => ({ size: 2 }),
        readFile: async () => "{}",
        decide: async () => {
          decided = true;
          return { options: [], confidence: 0 };
        },
      },
    ),
  ).rejects.toMatchObject({ code: 400 });
  expect(decided).toBe(false);
});
