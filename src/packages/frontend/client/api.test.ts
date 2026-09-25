/** @jest-environment jsdom */

function jsonResponse(value: unknown): Response {
  const response = {
    clone: () => response,
    json: async () => value,
  };
  return response as Response;
}

describe("frontend client api routing", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("uses the stored control plane by default", async () => {
    const fetchMock = jest.fn(async () => jsonResponse(true));
    global.fetch = fetchMock;
    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "/",
    }));
    jest.doMock("@cocalc/frontend/control-plane-origin", () => ({
      getControlPlaneOrigin: () => "https://bay-1.example.test",
    }));

    const { default: api } = await import("./api");
    await api("auth/requires-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bay-1.example.test/api/v2/auth/requires-token",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("can keep public pre-auth requests on the visible site", async () => {
    const fetchMock = jest.fn(async () => jsonResponse(true));
    global.fetch = fetchMock;
    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "/",
    }));
    jest.doMock("@cocalc/frontend/control-plane-origin", () => ({
      getControlPlaneOrigin: () => "https://stale-bay.example.test",
    }));

    const { default: api } = await import("./api");
    await api("auth/requires-token", undefined, { routing: "same-origin" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v2/auth/requires-token",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
});
