/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  oneAtATime,
  ownNetworkArgument,
  validateStartRequest,
} from "./shared-browser-containers";

describe("a project's browser containers", () => {
  it("start and stop one at a time, past failures", async () => {
    const events: string[] = [];
    const step =
      (name: string, ms: number, fail = false) =>
      async () => {
        events.push(`${name} begins`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`${name} ends`);
        if (fail) throw Error(name);
        return name;
      };
    const project = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    const stop = oneAtATime(project, step("stop", 30, true));
    const start = oneAtATime(project, step("start", 1));
    const elsewhere = oneAtATime(other, step("elsewhere", 1));
    await expect(stop).rejects.toThrow("stop");
    await expect(start).resolves.toBe("start");
    await expect(elsewhere).resolves.toBe("elsewhere");
    expect(events.indexOf("start begins")).toBeGreaterThan(
      events.indexOf("stop ends"),
    );
    // Another project's waits for nobody.
    expect(events.indexOf("elsewhere ends")).toBeLessThan(
      events.indexOf("stop ends"),
    );
  });
});

describe("a browser's own network", () => {
  it("never maps the host into it, whatever the project's network does", () => {
    expect(ownNetworkArgument("--network=pasta:--map-gw", true)).toBe(
      "--network=pasta:--no-map-gw,--map-guest-addr,none",
    );
    // A pasta without --map-guest-addr maps nothing to the host's address.
    expect(ownNetworkArgument("--network=pasta:--map-gw", false)).toBe(
      "--network=pasta:--no-map-gw",
    );
    expect(
      ownNetworkArgument(
        "--network=slirp4netns:allow_host_loopback=true",
        true,
      ),
    ).toBe("--network=slirp4netns:allow_host_loopback=false");
    expect(ownNetworkArgument("--network=none", true)).toBe("--network=none");
  });
});

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
