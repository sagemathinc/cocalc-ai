import { resolveProxyListenPort } from "./config";

describe("resolveProxyListenPort", () => {
  const originalProxyPort = process.env.COCALC_PROXY_PORT;

  afterEach(() => {
    if (originalProxyPort == null) {
      delete process.env.COCALC_PROXY_PORT;
    } else {
      process.env.COCALC_PROXY_PORT = originalProxyPort;
    }
  });

  test("preserves an explicit ephemeral port request", () => {
    expect(resolveProxyListenPort(0)).toBe(0);
  });

  test("uses the configured proxy port when no port is provided", () => {
    process.env.COCALC_PROXY_PORT = "9123";
    expect(resolveProxyListenPort()).toBe(9123);
  });
});
