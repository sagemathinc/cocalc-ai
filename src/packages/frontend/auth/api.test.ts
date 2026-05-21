/** @jest-environment jsdom */

describe("frontend/auth/api", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("uses the v2 auth bootstrap endpoint", async () => {
    const fetchMock = jest.fn(async () => ({
      json: async () => ({ signed_in: false }),
    }));
    (global as any).fetch = fetchMock;

    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "",
    }));
    jest.doMock("@cocalc/frontend/control-plane-origin", () => ({
      clearStoredControlPlaneOrigin: jest.fn(),
      getStoredControlPlaneOrigin: jest.fn(),
      setStoredControlPlaneOrigin: jest.fn(),
    }));
    jest.doMock("@cocalc/frontend/misc/remember-me", () => ({
      deleteRememberMe: jest.fn(),
    }));

    const { getAuthBootstrap } = await import("./api");
    await getAuthBootstrap();

    expect(fetchMock).toHaveBeenCalledWith("/api/v2/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
  });

  it("loads auth bootstrap from the stored control-plane origin", async () => {
    const fetchMock = jest.fn(async () => ({
      json: async () => ({
        signed_in: true,
        account_id: "acct-1",
        home_bay_id: "bay-1",
        home_bay_url: "https://bay-1-lite4b.cocalc.ai",
        impersonation: {
          active: true,
          actor_account_id: "admin-1",
          subject_account_id: "acct-1",
        },
      }),
    }));
    (global as any).fetch = fetchMock;

    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "",
    }));
    jest.doMock("@cocalc/frontend/control-plane-origin", () => ({
      clearStoredControlPlaneOrigin: jest.fn(),
      getStoredControlPlaneOrigin: jest.fn(
        () => "https://bay-1-lite4b.cocalc.ai",
      ),
      normalizeControlPlaneOrigin: jest.fn((x) => x),
      setStoredControlPlaneOrigin: jest.fn(),
    }));
    jest.doMock("@cocalc/frontend/misc/remember-me", () => ({
      deleteRememberMe: jest.fn(),
    }));

    const { getControlPlaneAuthBootstrap } = await import("./api");
    const bootstrap = await getControlPlaneAuthBootstrap();

    expect(bootstrap.impersonation?.active).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bay-1-lite4b.cocalc.ai/api/v2/auth/bootstrap",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("uses same-origin home-bay hints to retry bootstrap on the authoritative bay", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          signed_in: false,
          home_bay_id: "bay-1",
          home_bay_url: "https://bay-1-lite4b.cocalc.ai",
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          signed_in: true,
          account_id: "acct-1",
          home_bay_id: "bay-1",
          home_bay_url: "https://bay-1-lite4b.cocalc.ai",
          impersonation: {
            active: true,
            actor_account_id: "admin-1",
            subject_account_id: "acct-1",
          },
        }),
      });
    const setStoredControlPlaneOrigin = jest.fn();
    (global as any).fetch = fetchMock;

    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "",
    }));
    jest.doMock("@cocalc/frontend/control-plane-origin", () => ({
      clearStoredControlPlaneOrigin: jest.fn(),
      getStoredControlPlaneOrigin: jest.fn(() => undefined),
      normalizeControlPlaneOrigin: jest.fn((x) => x),
      setStoredControlPlaneOrigin,
    }));
    jest.doMock("@cocalc/frontend/misc/remember-me", () => ({
      deleteRememberMe: jest.fn(),
    }));

    const { getControlPlaneAuthBootstrap } = await import("./api");
    const bootstrap = await getControlPlaneAuthBootstrap();

    expect(setStoredControlPlaneOrigin).toHaveBeenCalledWith(
      "https://bay-1-lite4b.cocalc.ai",
    );
    expect(bootstrap.signed_in).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v2/auth/bootstrap",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://bay-1-lite4b.cocalc.ai/api/v2/auth/bootstrap",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("falls back when the stored control-plane origin is stale and signed out", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          signed_in: false,
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          signed_in: false,
          home_bay_id: "bay-1",
          home_bay_url: "https://bay-1-lite4b.cocalc.ai",
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          signed_in: true,
          account_id: "acct-1",
          home_bay_id: "bay-1",
          home_bay_url: "https://bay-1-lite4b.cocalc.ai",
        }),
      });
    (global as any).fetch = fetchMock;

    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "",
    }));
    jest.doMock("@cocalc/frontend/control-plane-origin", () => ({
      clearStoredControlPlaneOrigin: jest.fn(),
      getStoredControlPlaneOrigin: jest.fn(
        () => "https://old-bay-lite4b.cocalc.ai",
      ),
      normalizeControlPlaneOrigin: jest.fn((x) => x),
      setStoredControlPlaneOrigin: jest.fn(),
    }));
    jest.doMock("@cocalc/frontend/misc/remember-me", () => ({
      deleteRememberMe: jest.fn(),
    }));

    const { getControlPlaneAuthBootstrap } = await import("./api");
    const bootstrap = await getControlPlaneAuthBootstrap();

    expect(bootstrap.signed_in).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://old-bay-lite4b.cocalc.ai/api/v2/auth/bootstrap",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v2/auth/bootstrap",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://bay-1-lite4b.cocalc.ai/api/v2/auth/bootstrap",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("retries auth against the home bay using the v2 endpoint", async () => {
    const fetchMock = jest.fn(async () => ({
      json: async () => ({ account_id: "acct-1" }),
    }));
    const setStoredControlPlaneOrigin = jest.fn();
    (global as any).fetch = fetchMock;

    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "",
    }));
    jest.doMock("@cocalc/frontend/control-plane-origin", () => ({
      clearStoredControlPlaneOrigin: jest.fn(),
      getStoredControlPlaneOrigin: jest.fn(),
      setStoredControlPlaneOrigin,
    }));
    jest.doMock("@cocalc/frontend/misc/remember-me", () => ({
      deleteRememberMe: jest.fn(),
    }));

    const { retryAuthOnHomeBay } = await import("./api");
    await retryAuthOnHomeBay({
      endpoint: "auth/sign-in",
      wrongBay: {
        wrong_bay: true,
        home_bay_id: "bay-2",
        home_bay_url: "https://bay-2-lite4b.cocalc.ai",
        retry_token: "retry-token",
      },
      body: { email: "user@example.com" },
    });

    expect(setStoredControlPlaneOrigin).toHaveBeenCalledWith(
      "https://bay-2-lite4b.cocalc.ai",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bay-2-lite4b.cocalc.ai/api/v2/auth/sign-in",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "user@example.com",
          retry_token: "retry-token",
        }),
      },
    );
  });

  it("signs out against the stored home-bay origin and clears local auth hints", async () => {
    const fetchMock = jest.fn(async () => ({
      json: async () => ({ status: "success" }),
    }));
    const clearStoredControlPlaneOrigin = jest.fn();
    const deleteRememberMe = jest.fn();
    (global as any).fetch = fetchMock;

    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "",
    }));
    jest.doMock("@cocalc/frontend/control-plane-origin", () => ({
      clearStoredControlPlaneOrigin,
      getStoredControlPlaneOrigin: jest.fn(
        () => "https://bay-1-lite4b.cocalc.ai",
      ),
      setStoredControlPlaneOrigin: jest.fn(),
    }));
    jest.doMock("@cocalc/frontend/misc/remember-me", () => ({
      deleteRememberMe,
    }));

    const { signOutAuthSession } = await import("./api");
    await signOutAuthSession();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bay-1-lite4b.cocalc.ai/api/v2/accounts/sign-out",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ all: false }),
      },
    );
    expect(clearStoredControlPlaneOrigin).toHaveBeenCalled();
    expect(deleteRememberMe).toHaveBeenCalledWith("");
  });
});
