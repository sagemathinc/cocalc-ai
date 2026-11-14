import {
  isRefusedTargetHostname,
  safeProjectHostUrl,
  safeTunnelPort,
} from "./project-host-target";

describe("safeTunnelPort", () => {
  it("accepts integer ports in 1024..65535, as numbers or digit strings", () => {
    expect(safeTunnelPort(1024)).toBe(1024);
    expect(safeTunnelPort(9002)).toBe(9002);
    expect(safeTunnelPort(65535)).toBe(65535);
    expect(safeTunnelPort("43211")).toBe(43211);
  });

  it("refuses anything else", () => {
    for (const bad of [
      undefined,
      null,
      "",
      0,
      22,
      1023,
      65536,
      70000,
      9002.5,
      NaN,
      Infinity,
      -9002,
      "9002 ",
      " 9002",
      "9002.0",
      "0x2328",
      "1e4",
      "127.0.0.1:80",
      "80@evil.example",
      "evil.example#",
      "9002/x",
      "123456",
      true,
      [9002],
      { port: 9002 },
    ]) {
      expect(safeTunnelPort(bad)).toBeUndefined();
    }
  });
});

describe("isRefusedTargetHostname", () => {
  it("refuses loopback, unspecified, link-local, localhost and metadata names", () => {
    for (const h of [
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "0.1.2.3",
      "169.254.169.254",
      "169.254.0.1",
      "[::1]",
      "::1",
      "[::]",
      "[fe80::1]",
      "[febf::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[::ffff:a9fe:a9fe]",
      "[::127.0.0.1]",
      "localhost",
      "LOCALHOST",
      "localhost.",
      "foo.localhost",
      "metadata.google.internal",
      "metadata.google.internal.",
      "metadata",
      "",
    ]) {
      expect(isRefusedTargetHostname(h)).toBe(true);
    }
  });

  it("allows public names, public addresses and private ranges", () => {
    for (const h of [
      "host-1.cocalc.ai",
      "10.206.0.38",
      "10.0.0.5",
      "192.168.1.2",
      "172.16.0.9",
      "34.82.1.2",
      "[2001:db8::1]",
      "[fec0::1]",
    ]) {
      expect(isRefusedTargetHostname(h)).toBe(false);
    }
  });

  it("allows loopback only when asked, never link-local or metadata", () => {
    const opts = { allowLoopback: true };
    expect(isRefusedTargetHostname("127.0.0.1", opts)).toBe(false);
    expect(isRefusedTargetHostname("localhost", opts)).toBe(false);
    expect(isRefusedTargetHostname("[::1]", opts)).toBe(false);
    expect(isRefusedTargetHostname("169.254.169.254", opts)).toBe(true);
    expect(isRefusedTargetHostname("metadata.google.internal", opts)).toBe(
      true,
    );
    expect(isRefusedTargetHostname("0.0.0.0", opts)).toBe(true);
  });
});

describe("safeProjectHostUrl", () => {
  const saved = process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
  afterEach(() => {
    if (saved == null) {
      delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    } else {
      process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = saved;
    }
  });

  it("keeps ordinary host URLs unchanged", () => {
    for (const url of [
      "https://host-1.cocalc.ai",
      "http://10.206.0.38:9002",
      "https://host-123.example.com/base",
      "http://34.82.1.2:443/",
    ]) {
      expect(safeProjectHostUrl(url)).toBe(url);
    }
  });

  it("refuses URLs that name a refused address, including normalized forms", () => {
    delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    for (const url of [
      "http://127.0.0.1:5432",
      "http://localhost:9002",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0177.0.0.1/",
      "http://[::1]:80/",
      "http://169.254.169.254/computeMetadata/v1/",
      "http://metadata.google.internal/",
      "http://0.0.0.0:9002",
    ]) {
      expect(safeProjectHostUrl(url)).toBeUndefined();
    }
  });

  it("refuses non-http schemes, credentials and junk", () => {
    for (const bad of [
      "file:///etc/passwd",
      "ftp://host-1.cocalc.ai",
      "gopher://host-1.cocalc.ai",
      "http://user:pass@host-1.cocalc.ai",
      "http://user@host-1.cocalc.ai",
      "not a url",
      "",
      "   ",
      undefined,
      null,
      42,
      { href: "http://host-1.cocalc.ai" },
    ]) {
      expect(safeProjectHostUrl(bad)).toBeUndefined();
    }
  });

  it("allows loopback URLs only with the bay's development opt-in", () => {
    process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = "1";
    expect(safeProjectHostUrl("http://127.0.0.1:9002")).toBe(
      "http://127.0.0.1:9002",
    );
    expect(safeProjectHostUrl("http://169.254.169.254/")).toBeUndefined();
    process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = "yes";
    expect(safeProjectHostUrl("http://127.0.0.1:9002")).toBeUndefined();
  });
});
