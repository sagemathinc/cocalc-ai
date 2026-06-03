import {
  hasProjectRoleForAccessLandingBypass,
  projectAccessSignInHref,
  shouldFetchProjectAccessLandingInfo,
} from "./access-landing-auth";

describe("project access landing auth gate", () => {
  it("does not fetch project metadata for signed-out project routes", () => {
    expect(
      shouldFetchProjectAccessLandingInfo({
        isActive: true,
        accountIsReady: true,
        isLoggedIn: false,
        hasProject: false,
      }),
    ).toBe(false);
  });

  it("waits for account readiness before fetching project metadata", () => {
    expect(
      shouldFetchProjectAccessLandingInfo({
        isActive: true,
        accountIsReady: false,
        isLoggedIn: true,
        hasProject: false,
      }),
    ).toBe(false);
  });

  it("fetches access landing info only for signed-in unavailable active projects", () => {
    expect(
      shouldFetchProjectAccessLandingInfo({
        isActive: true,
        accountIsReady: true,
        isLoggedIn: true,
        hasProject: false,
      }),
    ).toBe(true);

    expect(
      shouldFetchProjectAccessLandingInfo({
        isActive: true,
        accountIsReady: true,
        isLoggedIn: true,
        hasProject: true,
      }),
    ).toBe(false);
  });

  it("does not fetch project metadata in lite mode", () => {
    expect(
      shouldFetchProjectAccessLandingInfo({
        isActive: true,
        accountIsReady: true,
        isLoggedIn: true,
        hasProject: false,
        liteMode: true,
      }),
    ).toBe(false);
  });

  it("keeps non-collaborators on the access landing even if project shell state exists", () => {
    const project = {
      getIn: (path: string[]) =>
        path.join("/") === "users/owner-account/group" ? "owner" : undefined,
    };

    expect(
      hasProjectRoleForAccessLandingBypass({
        accountId: "requester-account",
        project,
      }),
    ).toBe(false);

    expect(
      hasProjectRoleForAccessLandingBypass({
        accountId: "owner-account",
        project,
      }),
    ).toBe(true);

    expect(
      hasProjectRoleForAccessLandingBypass({
        accountId: "requester-account",
        project,
        isAdmin: true,
      }),
    ).toBe(true);
  });

  it("bypasses the access landing in lite mode", () => {
    expect(
      hasProjectRoleForAccessLandingBypass({
        accountId: "requester-account",
        project: null,
        liteMode: true,
      }),
    ).toBe(true);
  });

  it("preserves the project route in the sign-in target without leaking metadata", () => {
    expect(
      projectAccessSignInHref({
        pathname: "/projects/abc/files/home/user",
        search: "?lang_temp=en",
        hash: "#line=5",
      }),
    ).toBe(
      "/auth/sign-in?target=%2Fprojects%2Fabc%2Ffiles%2Fhome%2Fuser%3Flang_temp%3Den%23line%3D5",
    );
  });
});
