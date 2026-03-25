import { APP_BASE_PATH_ROUTE_MARKERS, hasHostAbsoluteRoutePrefix } from "./app";

describe("routing/app", () => {
  it("recognizes host absolute web routes", () => {
    expect(hasHostAbsoluteRoutePrefix("/projects")).toBe(true);
    expect(hasHostAbsoluteRoutePrefix("/projects/123/files")).toBe(true);
    expect(hasHostAbsoluteRoutePrefix("/auth/sign-in")).toBe(true);
    expect(hasHostAbsoluteRoutePrefix("/software")).toBe(true);
    expect(hasHostAbsoluteRoutePrefix("/billing?tab=upgrade")).toBe(true);
    expect(hasHostAbsoluteRoutePrefix("/home/wstein/x.txt")).toBe(false);
    expect(hasHostAbsoluteRoutePrefix("/tmp/authors.txt")).toBe(false);
  });

  it("exposes shared markers for base-path inference", () => {
    expect(APP_BASE_PATH_ROUTE_MARKERS).toContain("/projects");
    expect(APP_BASE_PATH_ROUTE_MARKERS).toContain("/auth");
    expect(APP_BASE_PATH_ROUTE_MARKERS).toContain("/ssh");
  });

  it("does not need separate top-level markers for project subroutes", () => {
    expect(hasHostAbsoluteRoutePrefix("/projects/abc/apps")).toBe(true);
    expect(hasHostAbsoluteRoutePrefix("/projects/abc/project-home")).toBe(true);
    expect(APP_BASE_PATH_ROUTE_MARKERS).not.toContain("/apps");
    expect(APP_BASE_PATH_ROUTE_MARKERS).not.toContain("/project-home");
  });
});
