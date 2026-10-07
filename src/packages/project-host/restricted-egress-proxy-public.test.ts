import { connect, createServer } from "node:net";
import {
  isPublicAddress,
  RestrictedEgressProxy,
} from "./restricted-egress-proxy";

async function connectStatus(proxyUrl: string, target: string) {
  const parsed = new URL(proxyUrl);
  const socket = connect(Number(parsed.port), "127.0.0.1");
  return await new Promise<string>((resolve, reject) => {
    let response = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n")) {
        socket.destroy();
        resolve(response.split("\r\n")[0]);
      }
    });
    socket.once("connect", () => {
      const credential = Buffer.from(
        `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
      ).toString("base64");
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${credential}\r\n\r\n`,
      );
    });
  });
}

test("only ordinary public unicast addresses are public", () => {
  for (const address of [
    "8.8.8.8",
    "140.82.112.3",
    "2607:f8b0:4005:80a::200e",
    "::ffff:8.8.8.8",
  ])
    expect(isPublicAddress(address)).toBe(true);
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "2002:7f00:1::",
    "2001:db8::1",
    "not-an-address",
  ])
    expect(isPublicAddress(address)).toBe(false);
});

describe("public host sessions", () => {
  const upstream = createServer((socket) => socket.resume());
  let upstreamPort = 0;
  const connected: string[] = [];
  const dns: Record<string, string[]> = {
    "example.com": ["93.184.215.14"],
    "rebind.test": ["93.184.215.14", "10.0.0.5"],
    "metadata.google.internal": ["169.254.169.254"],
    "v6.test": ["::1"],
  };
  const proxy = new RestrictedEgressProxy({
    name: "test",
    username: "test",
    allowedHosts: new Set(["api.anthropic.com"]),
    allowPublicHostSessions: true,
    resolveHost: async (hostname) => {
      if (hostname === "slow.test")
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (!dns[hostname]) throw Error("ENOTFOUND");
      return dns[hostname];
    },
    connectUpstream: (port, address) => {
      connected.push(`${address}:${port}`);
      return connect(upstreamPort, "127.0.0.1");
    },
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    upstreamPort = (upstream.address() as { port: number }).port;
  });
  afterAll(async () => {
    await proxy.shutdown();
    await new Promise((resolve) => upstream.close(resolve));
  });
  beforeEach(() => {
    connected.length = 0;
  });

  test("tunnel to the vetted public address, never to local networks", async () => {
    const session = await proxy.startSession({
      publicHosts: true,
      deniedHosts: new Set(["mcp-proxy.anthropic.com"]),
    });
    try {
      await expect(
        connectStatus(session.proxyUrl, "example.com:443"),
      ).resolves.toContain("200");
      // Connects to the address it checked, not a fresh DNS answer.
      expect(connected).toEqual(["93.184.215.14:443"]);
      connected.length = 0;
      for (const target of [
        "rebind.test:443", // any non-public answer refuses the host
        "metadata.google.internal:443",
        "v6.test:443",
        "unknown.test:443",
        "93.184.215.14:443", // IP literals carry no TLS server name
        "example.com:80",
        "mcp-proxy.anthropic.com:443",
      ])
        await expect(
          connectStatus(session.proxyUrl, target),
        ).resolves.toContain("403");
      expect(connected).toEqual([]);
      // Allowlisted hosts still connect by name.
      await expect(
        connectStatus(session.proxyUrl, "api.anthropic.com:443"),
      ).resolves.toContain("200");
      expect(connected).toEqual(["api.anthropic.com:443"]);
    } finally {
      session.close();
    }
  });

  test("a client reset while waiting or after a refusal closes only that socket", async () => {
    const session = await proxy.startSession({ publicHosts: true });
    const errors: unknown[] = [];
    const onUncaught = (error: unknown) => errors.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const parsed = new URL(session.proxyUrl);
      const credential = Buffer.from(
        `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
      ).toString("base64");
      for (const target of ["slow.test:443", "10.0.0.1:443"]) {
        const socket = connect(Number(parsed.port), "127.0.0.1");
        await new Promise<void>((resolve) => socket.once("connect", resolve));
        socket.write(
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${credential}\r\n\r\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        socket.resetAndDestroy();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errors).toEqual([]);
      // The proxy keeps serving.
      await expect(
        connectStatus(session.proxyUrl, "example.com:443"),
      ).resolves.toContain("200");
    } finally {
      process.off("uncaughtException", onUncaught);
      session.close();
    }
  });

  test("ordinary sessions keep the exact allowlist", async () => {
    const session = await proxy.startSession();
    try {
      await expect(
        connectStatus(session.proxyUrl, "example.com:443"),
      ).resolves.toContain("403");
      expect(connected).toEqual([]);
    } finally {
      session.close();
    }
  });

  test("a proxy without the option refuses public host sessions", async () => {
    const strict = new RestrictedEgressProxy({
      name: "strict",
      username: "strict",
      allowedHosts: new Set(["api.anthropic.com"]),
    });
    await expect(strict.startSession({ publicHosts: true })).rejects.toThrow(
      "does not permit public host sessions",
    );
    await strict.shutdown();
  });
});
