import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { commandLine } from "./computer";

// What the computer's login shell would print for this command line.
function run(parts: string[]): string {
  return execFileSync("sh", ["-c", commandLine(parts)], {
    encoding: "utf8",
    env: { ...process.env, HOME: "/tmp" },
  });
}

test("one argument is a shell line run there", () => {
  assert.equal(run(["echo a b | tr a x"]), "x b\n");
  assert.equal(run(["echo ~"]), "/tmp\n");
});

test("several arguments keep their quoting (sh -c '...')", () => {
  assert.equal(run(["sh", "-c", "echo 'a b' | tr a x"]), "x b\n");
  assert.equal(
    run(["printf", "%s|", "it's", "a b", "$HOME", "*"]),
    "it's|a b|$HOME|*|",
  );
});

test("plain words are left alone", () => {
  assert.equal(commandLine(["ls", "-la", "/var/log"]), "ls -la /var/log");
});
