const { resolveLaunchpadHost } = require("./onprem-config.js");

describe("launchpad onprem config", () => {
  const originalPublicHost = process.env.COCALC_PUBLIC_HOST;

  afterEach(() => {
    if (originalPublicHost == null) {
      delete process.env.COCALC_PUBLIC_HOST;
    } else {
      process.env.COCALC_PUBLIC_HOST = originalPublicHost;
    }
  });

  it("normalizes explicit public host URLs to hostnames", () => {
    process.env.COCALC_PUBLIC_HOST = "https://launchpad.example.com:9443";
    expect(resolveLaunchpadHost()).toBe("launchpad.example.com");
  });
});
