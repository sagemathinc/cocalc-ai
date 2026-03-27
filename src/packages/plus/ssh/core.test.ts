import { infoPathFor, parseTarget } from "./core";

describe("plus ssh core helpers", () => {
  const originalPlusHome = process.env.COCALC_PLUS_HOME;

  afterEach(() => {
    if (originalPlusHome == null) {
      delete process.env.COCALC_PLUS_HOME;
    } else {
      process.env.COCALC_PLUS_HOME = originalPlusHome;
    }
  });

  it("parses host-only and host:port targets", () => {
    expect(parseTarget("example.com")).toEqual({
      host: "example.com",
      port: null,
    });
    expect(parseTarget("example.com:2222")).toEqual({
      host: "example.com",
      port: 2222,
    });
  });

  it("uses COCALC_PLUS_HOME for per-target ssh state", () => {
    process.env.COCALC_PLUS_HOME = "/tmp/cocalc-plus-test";
    const info = infoPathFor("example.com:2222");
    expect(info.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(info.baseDir).toBe("/tmp/cocalc-plus-test/ssh");
    expect(info.localDir).toBe(`/tmp/cocalc-plus-test/ssh/${info.hash}`);
  });
});
