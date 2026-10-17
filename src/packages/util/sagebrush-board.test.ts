/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { boardPostedName, boardTextDigest } from "./sagebrush-board";

test("the posted name is the file's basename", () => {
  expect(boardPostedName("/home/user/a/q.board.json")).toBe("q.board.json");
  expect(boardPostedName("q.board.json")).toBe("q.board.json");
});

test("the digest is the SHA-256 of the UTF-8 text", async () => {
  expect(await boardTextDigest("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(await boardTextDigest("é")).toBe(
    "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
  );
});
