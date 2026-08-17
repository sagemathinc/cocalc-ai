/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSiteUrl,
  rememberMeCookieHeader,
  siteApiUrl,
  siteWithBasePath,
} from "./site-url";

test("normalizes an application URL while preserving its base path", () => {
  const site = normalizeSiteUrl(" https://Example.COM/tenant/path/ ");
  assert.deepEqual(site, {
    entered_app_url: "https://Example.COM/tenant/path/",
    canonical_app_url: "https://example.com/tenant/path",
    app_base_path: "/tenant/path",
    origin: "https://example.com",
  });
  assert.equal(
    siteApiUrl(site, "/auth/bootstrap"),
    "https://example.com/tenant/path/api/v2/auth/bootstrap",
  );
});

test("defaults a hostname to HTTPS", () => {
  assert.equal(
    normalizeSiteUrl("cocalc.ai").canonical_app_url,
    "https://cocalc.ai",
  );
});

test("rejects insecure, credentialed, and query-bearing URLs", () => {
  assert.throws(() => normalizeSiteUrl("http://example.com"), /HTTPS/);
  assert.throws(
    () => normalizeSiteUrl("https://user:secret@example.com"),
    /username or password/,
  );
  assert.throws(
    () => normalizeSiteUrl("https://example.com/?token=secret"),
    /query parameters/,
  );
});

test("allows only explicitly enumerated development HTTP hosts", () => {
  assert.equal(
    normalizeSiteUrl("http://localhost:9100", {
      allowInsecureHosts: ["localhost"],
    }).canonical_app_url,
    "http://localhost:9100",
  );
  assert.throws(
    () =>
      normalizeSiteUrl("http://192.168.1.20:9100", {
        allowInsecureHosts: ["localhost"],
      }),
    /HTTPS/,
  );
});

test("adds the advertised base path to a home-bay origin", () => {
  assert.equal(
    siteWithBasePath("https://bay-1.example.com", "/tenant").canonical_app_url,
    "https://bay-1.example.com/tenant",
  );
  assert.equal(
    siteWithBasePath("https://bay-1.example.com/already", "/tenant")
      .canonical_app_url,
    "https://bay-1.example.com/already",
  );
});

test("creates both scoped and legacy remember-me cookie names", () => {
  assert.equal(
    rememberMeCookieHeader("/tenant", "opaque"),
    "%2Ftenantremember_me=opaque; remember_me=opaque",
  );
  assert.equal(rememberMeCookieHeader("", "opaque"), "remember_me=opaque");
});
