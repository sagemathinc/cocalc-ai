import assert from "node:assert/strict";
import test from "node:test";

import { commandOf, pickComputer } from "./computer";

test("one argument after -- is a shell line there", () => {
  assert.deepEqual(commandOf(["du -sh ~/* | sort -h"]), {
    command: "du -sh ~/* | sort -h",
  });
});

test("several arguments are sent as exact argv, not joined", () => {
  const parts = ["sh", "-c", "du -sh ~/* | sort -h", "a\\\\b", "x\\'y"];
  assert.deepEqual(commandOf(parts), { argv: parts });
});

const hello = (computer_id: string, name: string) =>
  ({
    v: 1,
    computer_id,
    name,
    hostname: "h",
    os: "linux",
    arch: "x64",
    user: "u",
    running: 0,
  }) as const;

test("a computer is named by @name, name or id; a typo lists what is connected", () => {
  const a = hello("00000000-0000-4000-8000-00000000000a", "laptop");
  const b = hello("00000000-0000-4000-8000-00000000000b", "server");
  assert.equal(pickComputer([a, b], "@laptop"), a);
  assert.equal(pickComputer([a, b], "server"), b);
  assert.equal(pickComputer([a, b], b.computer_id.toUpperCase()), b);
  assert.throws(
    () => pickComputer([a, b], "@lapto"),
    /connected: @laptop, @server/,
  );
  assert.throws(() => pickComputer([], "@laptop"), /none is connected/);
  assert.throws(
    () => pickComputer([a, { ...b, name: "laptop" }], "laptop"),
    /several computers/,
  );
});
