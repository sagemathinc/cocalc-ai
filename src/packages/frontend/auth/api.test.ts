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
      setStoredControlPlaneOrigin: jest.fn(),
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
      setStoredControlPlaneOrigin,
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
});
