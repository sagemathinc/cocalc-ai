import assert from "node:assert/strict";
import test from "node:test";

import { commandOf } from "./computer";

test("one argument after -- is a shell line there", () => {
  assert.deepEqual(commandOf(["du -sh ~/* | sort -h"]), {
    command: "du -sh ~/* | sort -h",
  });
});

test("several arguments are sent as exact argv, not joined", () => {
  const parts = ["sh", "-c", "du -sh ~/* | sort -h", "a\\\\b", "x\\'y"];
  assert.deepEqual(commandOf(parts), { argv: parts });
});
