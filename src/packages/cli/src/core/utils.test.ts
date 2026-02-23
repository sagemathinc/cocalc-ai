import assert from "node:assert/strict";
import test from "node:test";

import {
  durationToMs,
  extractCookie,
  isRedirect,
  normalizeUrl,
  parseSshServer,
} from "./utils";

test("durationToMs parses units and defaults", () => {
  assert.equal(durationToMs(undefined, 123), 123);
  assert.equal(durationToMs("250ms", 0), 250);
  assert.equal(durationToMs("2s", 0), 2000);
  assert.equal(durationToMs("3m", 0), 180000);
  assert.equal(durationToMs("1h", 0), 3600000);
  assert.equal(durationToMs("7", 0), 7000);
});

test("durationToMs rejects invalid values", () => {
  assert.throws(() => durationToMs("abc", 0), /invalid duration/);
});

test("normalizeUrl handles schemes and trimming", () => {
  assert.equal(normalizeUrl("localhost:9100/"), "http://localhost:9100");
  assert.equal(normalizeUrl("http://example.com///"), "http://example.com");
  assert.equal(normalizeUrl("https://example.com/path/"), "https://example.com/path");
});

test("parseSshServer parses host and optional port", () => {
  assert.deepEqual(parseSshServer("example.com"), { host: "example.com" });
  assert.deepEqual(parseSshServer("example.com:2222"), {
    host: "example.com",
    port: 2222,
  });
  assert.deepEqual(parseSshServer("[2001:db8::1]:2200"), {
    host: "2001:db8::1",
    port: 2200,
  });
});

test("extractCookie returns only the requested cookie", () => {
  assert.equal(
    extractCookie("foo=1; Path=/, cocalc=abc123; HttpOnly", "cocalc"),
    "cocalc=abc123",
  );
  assert.equal(extractCookie("foo=1; Path=/", "missing"), undefined);
});

test("isRedirect matches redirect statuses", () => {
  assert.equal(isRedirect(301), true);
  assert.equal(isRedirect(302), true);
  assert.equal(isRedirect(303), true);
  assert.equal(isRedirect(307), true);
  assert.equal(isRedirect(308), true);
  assert.equal(isRedirect(200), false);
  assert.equal(isRedirect(404), false);
});
