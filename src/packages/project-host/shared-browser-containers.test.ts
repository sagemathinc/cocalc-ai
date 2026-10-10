/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { validateStartRequest } from "./shared-browser-containers";

describe("a shared browser container request", () => {
  it("takes only known browser ids, a fingerprint, and web URLs", () => {
    expect(
      validateStartRequest({
        appId: "cocalc-browser",
        network: "project",
        keyFingerprint: "0123456789abcdef0123456789abcdef",
        urls: [
          "https://example.com/",
          "--chrome=/bin/sh",
          "file:///etc/passwd",
          "javascript:alert(1)",
          "http://localhost:3000/ with space",
        ],
      }),
    ).toEqual({
      appId: "cocalc-browser",
      network: "project",
      keyFingerprint: "0123456789abcdef0123456789abcdef",
      urls: ["https://example.com/"],
    });
    expect(
      validateStartRequest({ appId: "cocalc-browser-0123456789abcdef" }),
    ).toEqual({
      appId: "cocalc-browser-0123456789abcdef",
      network: "own",
      keyFingerprint: null,
      urls: [],
    });
    for (const appId of ["cocalc-browser-x", "../etc", "other-app", ""])
      expect(() => validateStartRequest({ appId })).toThrow(/invalid/);
    expect(() =>
      validateStartRequest({
        appId: "cocalc-browser",
        keyFingerprint: "not hex; rm -rf /",
      }),
    ).toThrow(/fingerprint/);
  });
});
