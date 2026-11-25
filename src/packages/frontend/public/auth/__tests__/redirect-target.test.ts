/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Where a public sign-in or sign-up goes afterwards (?target=): same-origin app
// paths, and, for an OAuth client's sign-in (e.g. Sagebrush), exactly its
// authorize step, so that a person who makes a new account mid-sign-in comes
// back to the client.

let mockBase = "/";
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  get appBasePath() {
    return mockBase;
  },
}));

function load(base: string) {
  mockBase = base;
  let mod: typeof import("../routes");
  jest.isolateModules(() => {
    mod = require("../routes");
  });
  return mod!.getPublicAuthRedirectTargetFromSearch;
}

const AUTHORIZE =
  "/auth/oauth/authorize?response_type=code&client_id=sagebrush&redirect_uri=https%3A%2F%2Fsagebrush.space%2Fauth%2Fcallback&state=abc&code_challenge=xyz&code_challenge_method=S256";
const search = (target: string) => `?target=${encodeURIComponent(target)}`;

describe("getPublicAuthRedirectTargetFromSearch", () => {
  const redirect = load("/");

  it("keeps ordinary app targets as before", () => {
    expect(redirect(search("/projects?x=1#y"))).toBe("/projects?x=1#y");
    expect(redirect(search("/"))).toBeUndefined();
    expect(redirect("")).toBeUndefined();
  });

  it("accepts exactly the OAuth authorize step, with its query unchanged", () => {
    expect(redirect(search(AUTHORIZE))).toBe(AUTHORIZE);
  });

  it("still refuses every other auth or sso path", () => {
    for (const target of [
      "/auth/sign-in",
      "/auth/oauth/token?x=1",
      "/auth/oauth/authorize/x?client_id=sagebrush",
      "/auth/oauth/authorizeX?client_id=sagebrush",
      "/auth/oauth",
      "/sso/google",
    ]) {
      expect(redirect(search(target))).toBeUndefined();
    }
  });

  it("refuses other origins, protocol-relative, backslash and encoded tricks", () => {
    for (const target of [
      `https://evil.example${AUTHORIZE}`,
      `//evil.example${AUTHORIZE}`,
      `/\\evil.example${AUTHORIZE}`,
      `/auth\\oauth\\authorize?client_id=sagebrush`,
      "/auth/oauth/./authorize/../authorize/x?client_id=sagebrush",
      `${AUTHORIZE}#frag`,
    ]) {
      expect(redirect(search(target))).toBeUndefined();
    }
  });

  it("never takes an encoded variant for the authorize step", () => {
    // (a %2F or an encoded letter is not the authorize path: whatever else
    // these resolve to, it is never the authorize step)
    for (const target of [
      "/auth/oauth%2Fauthorize?client_id=sagebrush",
      "/auth%2Foauth%2Fauthorize?client_id=sagebrush",
      "/auth/oauth/%61uthorize?client_id=sagebrush",
      "/auth/oauth/authorize%3Fclient_id=sagebrush",
    ]) {
      expect(redirect(search(target)) ?? "").not.toMatch(
        /^\/auth\/oauth\/authorize(\?|$)/,
      );
    }
  });

  it("refuses an oversize authorize target", () => {
    const long = `${AUTHORIZE}&pad=${"a".repeat(2048)}`;
    expect(redirect(search(long))).toBeUndefined();
  });

  it("does not take an authorize step nested in another auth page's target", () => {
    expect(
      redirect(search(`/auth/sign-in?target=${encodeURIComponent(AUTHORIZE)}`)),
    ).toBeUndefined();
  });

  it("matches the authorize path after the app's base path, and only there", () => {
    const based = load("/base");
    expect(based(search(`/base${AUTHORIZE}`))).toBe(`/base${AUTHORIZE}`);
    // (outside the base path it is just another auth path, refused as before)
    expect(based(search(AUTHORIZE))).toBeUndefined();
    expect(based(search(`/base/base${AUTHORIZE}`))).not.toBe(
      `/base${AUTHORIZE}`,
    );
  });
});
