import assert from "node:assert/strict";
import { test } from "node:test";
import { reflectCliArgs } from "./reflect-cli-args";

test("uses the new forward vocabulary with the new Reflect release", () => {
  const args = ["forward", "remove", "12", "--stop"];
  assert.deepEqual(reflectCliArgs(args, "0.17.0\n"), args);
  assert.deepEqual(reflectCliArgs(args, "1.0.0"), args);
});
test("adapts to the independently pinned old npm dependency", () => {
  assert.deepEqual(
    reflectCliArgs(["forward", "remove", "12", "13", "--stop"], "0.15.1"),
    ["forward", "terminate", "12", "13"],
  );
  assert.throws(() => reflectCliArgs(["forward", "remove", "12"], "0.15.1"));
  assert.throws(() =>
    reflectCliArgs(["forward", "remove", "12", "--stop"], "unknown"),
  );
  assert.deepEqual(reflectCliArgs(["forward", "list", "--json"], "0.15.1"), [
    "forward",
    "list",
    "--json",
  ]);
});
