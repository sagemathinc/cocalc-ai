const {
  resolveLaunchpadHost,
  scrubLaunchpadInheritedRuntimeEnv,
} = require("./onprem-config.js");

describe("launchpad onprem config", () => {
  const originalPublicHost = process.env.COCALC_PUBLIC_HOST;
  const originalConatServer = process.env.CONAT_SERVER;

  afterEach(() => {
    if (originalPublicHost == null) {
      delete process.env.COCALC_PUBLIC_HOST;
    } else {
      process.env.COCALC_PUBLIC_HOST = originalPublicHost;
    }
    if (originalConatServer == null) {
      delete process.env.CONAT_SERVER;
    } else {
      process.env.CONAT_SERVER = originalConatServer;
    }
  });

  it("normalizes explicit public host URLs to hostnames", () => {
    process.env.COCALC_PUBLIC_HOST = "https://launchpad.example.com:9443";
    expect(resolveLaunchpadHost()).toBe("launchpad.example.com");
  });

  it("scrubs inherited project-host Conat server env", () => {
    process.env.CONAT_SERVER = "http://10.180.0.1:9102/";
    scrubLaunchpadInheritedRuntimeEnv();
    expect(process.env.CONAT_SERVER).toBeUndefined();
  });
});
