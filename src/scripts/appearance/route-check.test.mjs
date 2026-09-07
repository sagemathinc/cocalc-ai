import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCapturedRoute } from "./route-check.mjs";

test("accepts daemon markers and equivalent trailing slashes", () => {
  assertCapturedRoute(
    "https://example.com/projects/",
    "https://example.com/projects?_cocalc_browser_spawn=test",
  );
});
test("rejects redirects, login screens, another origin and missing evidence", () => {
  for (const actual of [
    "https://example.com/admin",
    "https://example.com/auth/sign-in",
    "https://other.com/admin/customers",
    undefined,
  ]) {
    assert.throws(() =>
      assertCapturedRoute("https://example.com/admin/customers", actual),
    );
  }
});
test("checks Essential hash routes and requested query parameters", () => {
  assert.throws(() =>
    assertCapturedRoute(
      "https://example.com/essential#/projects",
      "https://example.com/essential#/files",
    ),
  );
  assert.throws(() =>
    assertCapturedRoute(
      "https://example.com/docs?print=1",
      "https://example.com/docs",
    ),
  );
});
