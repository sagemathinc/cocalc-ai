import {
  inferAppBasePath,
  inferBasePathFromBaseElement,
  inferBasePathFromMetaElement,
} from "./app-base-path";

describe("inferAppBasePath", () => {
  it("uses the prefix before /static when booting from a static asset URL", () => {
    expect(inferAppBasePath("/base/static/app.js")).toBe("/base");
    expect(inferAppBasePath("/static/app.js")).toBe("/");
  });

  it("infers a subpath from refreshed app routes", () => {
    expect(inferAppBasePath("/projects")).toBe("/");
    expect(inferAppBasePath("/lang")).toBe("/");
    expect(inferAppBasePath("/redeem/ABC12345")).toBe("/");
    expect(inferAppBasePath("/base/lang/de")).toBe("/base");
    expect(inferAppBasePath("/base/redeem/ABC12345")).toBe("/base");
    expect(inferAppBasePath("/de")).toBe("/");
    expect(inferAppBasePath("/base/de")).toBe("/base");
    expect(
      inferAppBasePath(
        "/base/projects/00000000-1000-4000-8000-000000000000/files",
      ),
    ).toBe("/base");
    expect(inferAppBasePath("/base/projects")).toBe("/base");
    expect(inferAppBasePath("/base/auth/sign-in")).toBe("/base");
    expect(inferAppBasePath("/base/settings/profile")).toBe("/base");
    expect(inferAppBasePath("/base/ssh")).toBe("/base");
    expect(
      inferAppBasePath(
        "/base/projects/00000000-1000-4000-8000-000000000000/apps",
      ),
    ).toBe("/base");
    expect(
      inferAppBasePath(
        "/base/projects/00000000-1000-4000-8000-000000000000/project-home",
      ),
    ).toBe("/base");
  });

  it("keeps the route itself when refreshing the app root under a base path", () => {
    expect(inferAppBasePath("/base")).toBe("/base");
    expect(inferAppBasePath("/")).toBe("/");
  });

  it("matches personal-address route segments without matching longer names", () => {
    expect(inferAppBasePath("/u/jane")).toBe("/");
    expect(inferAppBasePath("/base/u/jane")).toBe("/base");
    expect(inferAppBasePath("/uploads")).toBe("/uploads");
    expect(inferAppBasePath("/uploads/base/u/jane")).toBe("/uploads/base");
  });

  it("infers the base path before project-host uuid routes", () => {
    expect(
      inferAppBasePath(
        "/00000000-1000-4000-8000-000000000000/files/home/user/a.pdf",
      ),
    ).toBe("/");
    expect(
      inferAppBasePath(
        "/base/00000000-1000-4000-8000-000000000000/files/home/user/a.pdf",
      ),
    ).toBe("/base");
  });
});

describe("inferBasePathFromMetaElement", () => {
  afterEach(() => {
    document.head.innerHTML = "";
  });

  it("derives the base path from the hub-injected meta tag", () => {
    document.head.innerHTML = '<meta name="cocalc-base-path" content="/">';
    expect(inferBasePathFromMetaElement()).toBe("/");

    document.head.innerHTML =
      '<meta name="cocalc-base-path" content="/launchpad">';
    expect(inferBasePathFromMetaElement()).toBe("/launchpad");
  });

  it("normalizes trailing slashes", () => {
    document.head.innerHTML =
      '<meta name="cocalc-base-path" content="/launchpad/">';
    expect(inferBasePathFromMetaElement()).toBe("/launchpad");
  });

  it("ignores absent or malformed meta tags", () => {
    expect(inferBasePathFromMetaElement()).toBeUndefined();

    document.head.innerHTML = '<meta name="cocalc-base-path" content="">';
    expect(inferBasePathFromMetaElement()).toBeUndefined();

    document.head.innerHTML =
      '<meta name="cocalc-base-path" content="launchpad">';
    expect(inferBasePathFromMetaElement()).toBeUndefined();
  });
});

describe("inferBasePathFromBaseElement", () => {
  afterEach(() => {
    document.head.innerHTML = "";
  });

  it("derives the base path from a hub-injected base element", () => {
    document.head.innerHTML = '<base href="/static/">';
    expect(inferBasePathFromBaseElement()).toBe("/");

    document.head.innerHTML = '<base href="/launchpad/static/">';
    expect(inferBasePathFromBaseElement()).toBe("/launchpad");
  });

  it("ignores absent or unrelated base elements", () => {
    expect(inferBasePathFromBaseElement()).toBeUndefined();

    document.head.innerHTML = '<base href="/somewhere/else/">';
    expect(inferBasePathFromBaseElement()).toBeUndefined();
  });
});
