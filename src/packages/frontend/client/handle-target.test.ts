/** @jest-environment jsdom */

describe("client handle-target", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@cocalc/frontend/misc/remember-me", () => ({
      hasRememberMe: jest.fn(() => true),
    }));
    delete (globalThis as any).__cocalc_public_app;
  });

  afterEach(() => {
    jest.dontMock("@cocalc/frontend/misc/remember-me");
    delete (globalThis as any).__cocalc_public_app;
  });

  it("does not rewrite public docs routes to projects when imported in public shell", async () => {
    window.history.replaceState({}, "", "/docs/projects/project-secrets");
    (globalThis as any).__cocalc_public_app = true;
    const pushState = jest.spyOn(window.history, "pushState");

    const { default: target } = await import("./handle-target");

    expect(target).toBe("docs/projects/project-secrets");
    expect(pushState).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/docs/projects/project-secrets");
  });

  it("preserves public target query values without rewriting history", async () => {
    window.history.replaceState(
      {},
      "",
      "/static/public.html?target=%2Fdocs%2Fprojects%2Fproject-secrets",
    );
    (globalThis as any).__cocalc_public_app = true;
    const pushState = jest.spyOn(window.history, "pushState");

    const { default: target } = await import("./handle-target");

    expect(target).toBe("docs/projects/project-secrets");
    expect(pushState).not.toHaveBeenCalled();
  });
});
