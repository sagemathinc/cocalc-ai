import { execFileSync } from "node:child_process";
import {
  parseSshTargetSpec,
  safeSshDestination,
  safeSshHost,
  safeSshLoginName,
  safeSshPort,
  shellCommand,
  shellQuote,
  sshDestinationArgs,
} from "./ssh-destination";

const saved = process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
beforeEach(() => {
  delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
});
afterAll(() => {
  if (saved != null)
    process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = saved;
});

describe("safeSshLoginName", () => {
  it("accepts plain login names", () => {
    for (const name of [
      "ubuntu",
      "user",
      "local",
      "_svc",
      "a",
      "cocalc-host",
      "u_1-2",
    ]) {
      expect(safeSshLoginName(name)).toBe(name);
    }
    expect(safeSshLoginName("a".repeat(32))).toBe("a".repeat(32));
  });

  it("refuses anything that could be an option or carry other text", () => {
    for (const bad of [
      "-oProxyCommand=touch /tmp/x",
      "-l",
      "--",
      "",
      " ubuntu",
      "ubuntu ",
      "Ubuntu",
      "1user",
      "user@host",
      "us er",
      "user;id",
      "user$(id)",
      "user`id`",
      "user'x",
      'user"x',
      "user\nx",
      "user\0x",
      "ubüntu",
      "a".repeat(33),
      undefined,
      null,
      7,
      ["ubuntu"],
    ]) {
      expect(safeSshLoginName(bad)).toBeUndefined();
    }
  });
});

describe("safeSshHost", () => {
  it("accepts public and private addresses and DNS names", () => {
    for (const host of [
      "34.82.1.2",
      "10.0.0.5",
      "192.168.1.20",
      "172.16.3.4",
      "2001:db8::1",
      "fd00::5",
      "host-1.example.com",
      "myserver",
      "my-server.lan",
      "a1.b2.c3",
    ]) {
      expect(safeSshHost(host)).toBe(host);
    }
  });

  it("refuses the named classes: loopback, unspecified, link-local, metadata", () => {
    for (const host of [
      "127.0.0.1",
      "127.9.9.9",
      "0.0.0.0",
      "0.1.2.3",
      "169.254.169.254",
      "169.254.1.1",
      "::1",
      "::",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::127.0.0.1",
      "::7f00:1",
      "64:ff9b::a9fe:a9fe",
      "localhost",
      "foo.localhost",
      "metadata.google.internal",
      "metadata",
    ]) {
      expect(safeSshHost(host)).toBeUndefined();
    }
  });

  it("refuses option-like, malformed and ambiguous hosts", () => {
    for (const host of [
      "-oProxyCommand=id",
      "-host",
      "host-",
      "a..b",
      ".host",
      "host.",
      "",
      "ho st",
      "host;id",
      "host$(id)",
      "hóst",
      "fe80::1%eth0",
      "2001:db8::1%1",
      "[2001:db8::1]",
      "1.2.3",
      "0x7f.1",
      "2130706433",
      "1.2.3.4.5",
      "256.1.1.1",
      "a".repeat(64) + ".com",
      undefined,
      null,
      1234,
    ]) {
      expect(safeSshHost(host)).toBeUndefined();
    }
  });

  it("allows loopback only with the development opt-in, never link-local", () => {
    expect(safeSshHost("127.0.0.1", { allowLoopback: true })).toBe("127.0.0.1");
    expect(safeSshHost("localhost", { allowLoopback: true })).toBe("localhost");
    expect(
      safeSshHost("169.254.169.254", { allowLoopback: true }),
    ).toBeUndefined();
    process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = "1";
    expect(safeSshHost("127.0.0.1")).toBe("127.0.0.1");
  });

  it("with requireIp accepts only addresses", () => {
    expect(safeSshHost("34.82.1.2", { requireIp: true })).toBe("34.82.1.2");
    expect(safeSshHost("2001:db8::1", { requireIp: true })).toBe("2001:db8::1");
    expect(
      safeSshHost("host.example.com", { requireIp: true }),
    ).toBeUndefined();
  });
});

describe("safeSshPort", () => {
  it("accepts 1..65535", () => {
    expect(safeSshPort(22)).toBe(22);
    expect(safeSshPort("2222")).toBe(2222);
    expect(safeSshPort("65535")).toBe(65535);
    expect(safeSshPort(1)).toBe(1);
  });
  it("refuses everything else", () => {
    for (const bad of [
      0,
      "0",
      65536,
      "65536",
      "22x",
      " 22",
      "-22",
      "2e3",
      22.5,
      "",
      NaN,
      undefined,
      null,
    ]) {
      expect(safeSshPort(bad)).toBeUndefined();
    }
  });
});

describe("parseSshTargetSpec (self-host target grammar)", () => {
  it("parses each accepted form", () => {
    expect(parseSshTargetSpec("host.example.com")).toEqual({
      host: "host.example.com",
    });
    expect(parseSshTargetSpec("  ubuntu@10.0.0.5 ")).toEqual({
      user: "ubuntu",
      host: "10.0.0.5",
    });
    expect(parseSshTargetSpec("ubuntu@10.0.0.5:2222")).toEqual({
      user: "ubuntu",
      host: "10.0.0.5",
      port: 2222,
    });
    expect(parseSshTargetSpec("myserver:22")).toEqual({
      host: "myserver",
      port: 22,
    });
    expect(parseSshTargetSpec("[2001:db8::1]")).toEqual({
      host: "2001:db8::1",
    });
    expect(parseSshTargetSpec("u@[2001:db8::1]:2200")).toEqual({
      user: "u",
      host: "2001:db8::1",
      port: 2200,
    });
    expect(parseSshTargetSpec("2001:db8::1")).toEqual({ host: "2001:db8::1" });
  });

  it("refuses every malformed or hostile form", () => {
    for (const bad of [
      "-oProxyCommand=id",
      "user@-oProxyCommand=id",
      "-l@host",
      "@host",
      "user@",
      "user@host@other",
      "User@host",
      "user@host:",
      "user@host:0",
      "user@host:65536",
      "user@host:22x",
      "user@host:22:33",
      "user@-host",
      "user@host-",
      "user@a..b",
      "[2001:db8::1",
      "2001:db8::1]",
      "[host.example.com]:22",
      "[2001:db8::1]x",
      "[2001:db8::1]:",
      "[fe80::1%eth0]",
      "fe80::1%eth0",
      "user@127.0.0.1",
      "user@localhost",
      "user@169.254.169.254:22",
      "metadata.google.internal",
      "[::1]:22",
      "user@ho st",
      "user@host\nProxyCommand=id",
      "user@ho\tst",
      "user@hóst",
      "",
      "   ",
      undefined,
      null,
      { host: "x" },
    ]) {
      expect(parseSshTargetSpec(bad)).toBeUndefined();
    }
  });
});

describe("safeSshDestination and sshDestinationArgs", () => {
  it("builds user@host only from checked parts", () => {
    expect(safeSshDestination("ubuntu", "34.82.1.2")).toBe("ubuntu@34.82.1.2");
    expect(
      safeSshDestination("-oProxyCommand=id", "34.82.1.2"),
    ).toBeUndefined();
    expect(safeSshDestination("ubuntu", "-oProxyCommand=id")).toBeUndefined();
    expect(safeSshDestination("ubuntu", "127.0.0.1")).toBeUndefined();
    expect(
      safeSshDestination("ubuntu", "host.example.com", { requireIp: true }),
    ).toBeUndefined();
  });

  it("puts -- before the destination", () => {
    expect(sshDestinationArgs("u@h", ["bash", "-se"])).toEqual([
      "--",
      "u@h",
      "bash",
      "-se",
    ]);
  });
});

describe("shellQuote / shellCommand", () => {
  const hostile = [
    "plain",
    "",
    "a b",
    "semi;colon",
    "$(touch /tmp/never)",
    "${HOME}",
    "`id`",
    "it's",
    'dq"uote',
    "new\nline",
    "-leading-dash",
    "--name",
    "tab\there",
    "back\\slash",
    "glob*?[x]",
    "pipe|amp&lt<gt>",
    "~tilde",
    "#hash",
    "ünïcode",
  ];

  it("a POSIX shell reads each value back as exactly that one word", () => {
    // printf '%s\0' prints each argument it gets; split on NUL to see them.
    const out = execFileSync(
      "sh",
      ["-c", `printf '%s\\0' ${hostile.map(shellQuote).join(" ")}`],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
      },
    );
    expect(out.split("\0").slice(0, -1)).toEqual(hostile);
  });

  it("shellCommand keeps the argv through a second shell level (bash -lc)", () => {
    const inner = shellCommand(["printf", "%s\\0", ...hostile]);
    const outer = shellCommand(["bash", "-c", inner]);
    const out = execFileSync("sh", ["-c", outer], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
    });
    expect(out.split("\0").slice(0, -1)).toEqual(hostile);
  });
});
