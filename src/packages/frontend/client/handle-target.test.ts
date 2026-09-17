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
    jest.restoreAllMocks();
    jest.dontMock("@cocalc/frontend/misc/remember-me");
    delete (globalThis as any).__cocalc_public_app;
  });

  it("restores a thread permalink without adding a browser history entry", async () => {
    window.history.replaceState(
      { marker: "retained" },
      "",
      "/static/app.html?target=projects%2Fp1%2Ffiles%2Fhome%2Fuser%2Fsend.chat&tab=vms#thread=beta",
    );
    const pushState = jest.spyOn(window.history, "pushState");
    const replaceState = jest.spyOn(window.history, "replaceState");
    const { default: target } = await import("./handle-target");
    expect(target).toBe("projects/p1/files/home/user/send.chat");
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe(
      "/projects/p1/files/home/user/send.chat",
    );
    expect(window.location.search).toBe("?tab=vms");
    expect(window.location.hash).toBe("#thread=beta");
    expect(window.history.state).toEqual({ marker: "retained" });
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
