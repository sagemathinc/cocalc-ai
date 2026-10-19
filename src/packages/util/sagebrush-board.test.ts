/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sha256 } from "@noble/hashes/sha2";
import {
  boardPostedName,
  boardTextDigest,
  canonicalBoardKey,
  uuidV5,
} from "./sagebrush-board";

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

// Codex on #1134: on a plain-http site there is no crypto.subtle, and the
// digest is @noble/hashes' SHA-256; it must be exactly what the server
// computes, since it binds the board text decide checks against.
async function withoutSubtle<T>(f: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: real?.value?.getRandomValues },
  });
  try {
    return await f();
  } finally {
    if (real) Object.defineProperty(globalThis, "crypto", real);
  }
}

test("without crypto.subtle, the digest meets NIST's SHA-256 vectors", async () => {
  // FIPS 180-4 examples (NIST CSRC): one block, two blocks, a million "a"
  const vectors: [string, string][] = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "a".repeat(1_000_000),
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    ],
  ];
  const got = await withoutSubtle(() =>
    Promise.all(vectors.map(([text]) => boardTextDigest(text))),
  );
  expect(got).toEqual(vectors.map(([, digest]) => digest));
});

test("without crypto.subtle, the digest is Node's SHA-256", async () => {
  const { createHash, randomBytes } = require("crypto");
  // every length across the padding boundaries, and some large ones
  for (const n of [...Array(200).keys(), 1000, 4096, 65537, 1 << 20]) {
    const b = new Uint8Array(randomBytes(n));
    expect(sha256(b)).toEqual(
      new Uint8Array(createHash("sha256").update(b).digest()),
    );
  }
  const texts = ["", "é", '{"format":"sagebrush-board"}', "x".repeat(100_000)];
  const withSubtle = await Promise.all(texts.map(boardTextDigest));
  expect(
    await withoutSubtle(() => Promise.all(texts.map(boardTextDigest))),
  ).toEqual(withSubtle);
});

// The board-answers message ids as the crypto.subtle implementation made
// them (a08e62f20e): unchanged, byte for byte.
const BOARD_NAMESPACE = "6f3a1c62-91d4-4f57-9a0e-b0a2d1c45e17";
const BOARD_ANSWER_ID_VECTORS: [string, string, string][] = [
  [
    "thread-1",
    "0d9f3b6e-6a31-4c2f-9d6b-0f6f2c1b7a11",
    "3eea1915-d1a7-5ec5-b306-834b3f6fbe3c",
  ],
  [
    "95e409bb-c34b-406d-a924-c5fd22a09cea",
    "3f2b8c1e-7a4d-4e9f-8b6c-2d1e0f9a8b7c",
    "b22822e5-b711-504e-95bd-4174e1b9b098",
  ],
  [
    "thème-é-🦊",
    "00000000-0000-4000-8000-000000000000",
    "9c16a65a-54e4-547c-938c-ef28c02b146a",
  ],
  ["", "", "9b2b7552-7085-52ee-b523-abe01d72aae9"],
];

test("uuidV5: RFC 9562's example, and the ids it made before", () => {
  expect(
    uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
  ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  for (const [thread, submission, id] of BOARD_ANSWER_ID_VECTORS) {
    expect(
      uuidV5(`board-answers\n${thread}\n${submission}`, BOARD_NAMESPACE),
    ).toBe(id);
  }
});

// What a browser runs: the uuid package's browser build, whose SHA-1 is
// plain JavaScript (no crypto at all).
test("the browser build of uuid v5 makes the same ids, without crypto", () => {
  const path = require("path");
  const fs = require("fs");
  const dir = path.join(
    path.dirname(require.resolve("uuid/package.json")),
    "dist/cjs-browser",
  );
  expect(fs.readFileSync(path.join(dir, "sha1.js"), "utf8")).not.toMatch(
    /crypto/,
  );
  const browserV5 = require(path.join(dir, "index.js")).v5;
  for (const [thread, submission, id] of BOARD_ANSWER_ID_VECTORS) {
    expect(
      browserV5(`board-answers\n${thread}\n${submission}`, BOARD_NAMESPACE),
    ).toBe(id);
  }
});

// Codex on #1134: one key per board file, for the per-board limits.
test("canonicalBoardKey: HOME aliases are made relative; other files stay apart", () => {
  for (const p of [
    "work/q.board.json",
    "/home/user/work/q.board.json",
    "/root/work/q.board.json",
    "./work/q.board.json",
    "work//q.board.json",
    "work/x/../q.board.json",
    "/home/user//work/./q.board.json",
  ]) {
    expect(canonicalBoardKey(p)).toBe("work/q.board.json");
  }
  expect(canonicalBoardKey("other.board.json")).toBe("other.board.json");
  expect(canonicalBoardKey("/tmp/q.board.json")).toBe("/tmp/q.board.json");
  // out of HOME by "..": another absolute file, not HOME's
  expect(canonicalBoardKey("/home/user/../q.board.json")).toBe(
    "/home/q.board.json",
  );
  for (const p of [
    "",
    ".",
    "/",
    "/home/user",
    "/home/user/",
    "../q.board.json",
  ]) {
    expect(canonicalBoardKey(p)).toBeUndefined();
  }
});
