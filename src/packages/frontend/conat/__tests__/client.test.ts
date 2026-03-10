import { routeProjectHostHttpUrl } from "../project-host-route";

describe("routeProjectHostHttpUrl", () => {
  it("routes relative project URLs through the project-host address", () => {
    expect(
      routeProjectHostHttpUrl({
        url: "/7d/proxy/6002/",
        routingAddress: "https://host-abc.example.com",
      }),
    ).toBe("https://host-abc.example.com/7d/proxy/6002/");
  });

  it("reroutes site-origin project URLs through the project-host address", () => {
    expect(
      routeProjectHostHttpUrl({
        url: "https://dev.cocalc.ai/7d/port/6002/?x=1",
        routingAddress: "https://host-abc.example.com",
        windowOrigin: "https://dev.cocalc.ai",
      }),
    ).toBe("https://host-abc.example.com/7d/port/6002/?x=1");
  });

  it("preserves already routed host URLs", () => {
    expect(
      routeProjectHostHttpUrl({
        url: "https://host-abc.example.com/7d/apps/jupyterlab/",
        routingAddress: "https://host-abc.example.com",
      }),
    ).toBe("https://host-abc.example.com/7d/apps/jupyterlab/");
  });

  it("reroutes localhost service URLs through a local-proxy host path", () => {
    expect(
      routeProjectHostHttpUrl({
        url: "http://127.0.0.1:6002/lab",
        routingAddress: "https://dev.cocalc.ai/host-abc",
      }),
    ).toBe("https://dev.cocalc.ai/host-abc/lab");
  });

  it("leaves unrelated external absolute URLs unchanged", () => {
    expect(
      routeProjectHostHttpUrl({
        url: "https://example.net/demo",
        routingAddress: "https://host-abc.example.com",
        windowOrigin: "https://dev.cocalc.ai",
      }),
    ).toBe("https://example.net/demo");
  });
});
