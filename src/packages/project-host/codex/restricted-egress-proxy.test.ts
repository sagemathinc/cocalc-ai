import { connect, createServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  isAllowedCodexEgressTarget,
  shutdownRestrictedCodexEgressProxyForTesting,
  startRestrictedCodexEgressProxySession,
} from "./restricted-egress-proxy";
import { RestrictedEgressProxy } from "../restricted-egress-proxy";

async function connectResponse({
  proxyUrl,
  target,
  authenticated,
}: {
  proxyUrl: string;
  target: string;
  authenticated: boolean;
}): Promise<string> {
  const parsed = new URL(proxyUrl);
  const socket = connect(Number(parsed.port), "127.0.0.1");
  return await new Promise<string>((resolve, reject) => {
    let response = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.once("connect", () => {
      const authorization = authenticated
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
          ).toString("base64")}\r\n`
        : "";
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization}\r\n`,
      );
    });
  });
}

afterAll(async () => {
  await shutdownRestrictedCodexEgressProxyForTesting();
});

describe("restricted Codex egress proxy", () => {
  it("allows only exact OpenAI TLS targets", () => {
    expect(isAllowedCodexEgressTarget("chatgpt.com:443")).toBe(true);
    expect(isAllowedCodexEgressTarget("api.openai.com:443")).toBe(true);
    expect(isAllowedCodexEgressTarget("auth.openai.com:443")).toBe(true);
    expect(isAllowedCodexEgressTarget("chatgpt.com.evil.test:443")).toBe(false);
    expect(isAllowedCodexEgressTarget("github.com:443")).toBe(false);
    expect(isAllowedCodexEgressTarget("chatgpt.com:80")).toBe(false);
  });

  it("requires a session credential before checking the destination", async () => {
    const session = await startRestrictedCodexEgressProxySession();
    try {
      await expect(
        connectResponse({
          proxyUrl: session.proxyUrl,
          target: "github.com:443",
          authenticated: false,
        }),
      ).resolves.toContain("407 Proxy Authentication Required");
    } finally {
      session.close();
    }
  });

  it("starts concurrent sessions through one listener", async () => {
    await shutdownRestrictedCodexEgressProxyForTesting();
    const sessions = await Promise.all([
      startRestrictedCodexEgressProxySession(),
      startRestrictedCodexEgressProxySession(),
      startRestrictedCodexEgressProxySession(),
    ]);
    try {
      const ports = sessions.map((session) => new URL(session.proxyUrl).port);
      expect(new Set(ports).size).toBe(1);
      expect(new Set(sessions.map((session) => session.proxyUrl)).size).toBe(3);
    } finally {
      for (const session of sessions) session.close();
    }
  });

  it("rejects authenticated tunnels to non-OpenAI hosts", async () => {
    const session = await startRestrictedCodexEgressProxySession();
    try {
      await expect(
        connectResponse({
          proxyUrl: session.proxyUrl,
          target: "github.com:443",
          authenticated: true,
        }),
      ).resolves.toContain("403 Forbidden");
    } finally {
      session.close();
    }
  });
});

/** The exact bytes Node's TLS client sends first. */
async function captureClientHello(servername: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once("data", (data) => {
        socket.destroy();
        server.close();
        resolve(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      tlsConnect({
        host: "127.0.0.1",
        port,
        servername,
        rejectUnauthorized: false,
      }).on("error", () => {});
    });
    server.on("error", reject);
  });
}

/** A proxy whose upstream is a local server recording what it receives. */
async function localProxy(options = {}) {
  const received: Buffer[] = [];
  const upstreamServer = createServer((socket) => {
    socket.on("data", (data) => received.push(data));
  });
  await new Promise<void>((resolve) =>
    upstreamServer.listen(0, "127.0.0.1", resolve),
  );
  const upstreamPort = (upstreamServer.address() as { port: number }).port;
  const proxy = new RestrictedEgressProxy({
    name: "test",
    username: "cocalc-codex",
    allowedHosts: new Set(["chatgpt.com", "api.anthropic.com"]),
    connectUpstream: () => connect(upstreamPort, "127.0.0.1"),
    ...options,
  });
  const session = await proxy.startSession();
  const parsed = new URL(session.proxyUrl);
  return {
    received,
    proxy,
    port: Number(parsed.port),
    authorization: `Proxy-Authorization: Basic ${Buffer.from(
      `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
    ).toString("base64")}\r\n`,
    close: async () => {
      session.close();
      await proxy.shutdown();
      await new Promise((resolve) => upstreamServer.close(resolve));
    },
  };
}

/** CONNECT, wait for 200, send `payload`; resolve when the proxy closes. */
async function tunnel(
  proxy: Awaited<ReturnType<typeof localProxy>>,
  target: string,
  payload: Buffer,
): Promise<{ established: boolean; closed: boolean }> {
  const socket = connect(proxy.port, "127.0.0.1");
  let established = false;
  let response = "";
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ established, closed: false });
    }, 3000);
    socket.on("data", (chunk) => {
      if (established) return;
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) {
        established = response.startsWith("HTTP/1.1 200");
        socket.write(payload);
      }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve({ established, closed: true });
    });
    socket.on("error", () => {});
    socket.once("connect", () =>
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${proxy.authorization}\r\n`,
      ),
    );
  });
}

describe("restricted egress tunnels verify the TLS destination", () => {
  it("forwards nothing when the ClientHello names a different host", async () => {
    const proxy = await localProxy({ setupTimeoutMs: 2000 });
    try {
      const hello = await captureClientHello("example.com");
      await expect(tunnel(proxy, "chatgpt.com:443", hello)).resolves.toEqual({
        established: true,
        closed: true,
      });
      expect(Buffer.concat(proxy.received).length).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it("forwards non-TLS data never", async () => {
    const proxy = await localProxy({ setupTimeoutMs: 2000 });
    try {
      await expect(
        tunnel(proxy, "chatgpt.com:443", Buffer.from("GET / HTTP/1.1\r\n\r\n")),
      ).resolves.toMatchObject({ closed: true });
      expect(Buffer.concat(proxy.received).length).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it.each(["chatgpt.com", "api.anthropic.com"])(
    "forwards the exact ClientHello for %s",
    async (hostname) => {
      const proxy = await localProxy();
      try {
        const hello = await captureClientHello(hostname);
        await tunnel(proxy, `${hostname}:443`, hello);
        expect(Buffer.concat(proxy.received).equals(hello)).toBe(true);
      } finally {
        await proxy.close();
      }
    },
  );
});

test("session allowlists are isolated snapshots and cannot expand proxy authority", async () => {
  const local = await localProxy();
  const hosts = new Set(["api.anthropic.com", "example.com"]);
  const narrowed = await local.proxy.startSession({ allowedHosts: hosts });
  hosts.add("chatgpt.com");
  try {
    for (const hostname of ["chatgpt.com", "example.com"]) {
      await expect(
        connectResponse({
          proxyUrl: narrowed.proxyUrl,
          target: `${hostname}:443`,
          authenticated: true,
        }),
      ).resolves.toContain("403 Forbidden");
    }
    await expect(
      connectResponse({
        proxyUrl: narrowed.proxyUrl,
        target: "api.anthropic.com:443",
        authenticated: true,
      }),
    ).resolves.toContain("200 Connection Established");
    // A second session on the same listener keeps the original authority.
    const hello = await captureClientHello("chatgpt.com");
    await tunnel(local, "chatgpt.com:443", hello);
    expect(Buffer.concat(local.received).equals(hello)).toBe(true);
  } finally {
    narrowed.close();
    await local.close();
  }
});

describe("restricted egress connections are bounded before authentication", () => {
  it("closes a connection that never completes its CONNECT request", async () => {
    const proxy = await localProxy({ setupTimeoutMs: 200 });
    try {
      const socket = connect(proxy.port, "127.0.0.1");
      socket.on("error", () => {});
      socket.once("connect", () =>
        socket.write("CONNECT chatgpt.com:443 HTTP/1.1\r\n"),
      );
      const started = Date.now();
      await new Promise((resolve) => socket.once("close", resolve));
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await proxy.close();
    }
  });

  it("refuses connections beyond the global cap", async () => {
    const proxy = await localProxy({ maxConnections: 3 });
    const sockets: Socket[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const socket = connect(proxy.port, "127.0.0.1");
        socket.on("error", () => {});
        sockets.push(socket);
        await new Promise((resolve) => socket.once("connect", resolve));
      }
      // Let the server register them.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const extra = connect(proxy.port, "127.0.0.1");
      extra.on("error", () => {});
      await new Promise((resolve) => extra.once("close", resolve));
      for (const socket of sockets) expect(socket.destroyed).toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await proxy.close();
    }
  });
});

describe("setup is bounded by an absolute deadline", () => {
  it("closes a client that trickles its CONNECT request", async () => {
    const proxy = await localProxy({ setupTimeoutMs: 200 });
    try {
      const socket = connect(proxy.port, "127.0.0.1");
      socket.on("error", () => {});
      const request = Buffer.from(
        "CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: x",
      );
      let sent = 0;
      const trickle = setInterval(() => {
        if (!socket.destroyed && sent < request.length)
          socket.write(request.subarray(sent, ++sent));
      }, 50);
      const started = Date.now();
      await new Promise((resolve) => socket.once("close", resolve));
      clearInterval(trickle);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(sent).toBeLessThan(request.length);
    } finally {
      await proxy.close();
    }
  });

  it("releases a client that disconnects before its ClientHello", async () => {
    const proxy = await localProxy({ setupTimeoutMs: 60_000 });
    try {
      for (let i = 0; i < 5; i++) {
        const socket = connect(proxy.port, "127.0.0.1");
        socket.on("error", () => {});
        await new Promise<void>((resolve) => {
          socket.on("data", (chunk) => {
            if (chunk.toString("latin1").startsWith("HTTP/1.1 200")) {
              socket.destroy();
              resolve();
            }
          });
          socket.once("connect", () =>
            socket.write(
              `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n${proxy.authorization}\r\n`,
            ),
          );
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(proxy.proxy.stateForTesting()).toEqual({
        connections: 0,
        pendingDeadlines: 0,
      });
    } finally {
      await proxy.close();
    }
  });

  it("leaves nothing pending after shutdown during a ClientHello wait", async () => {
    const proxy = await localProxy({ setupTimeoutMs: 60_000 });
    const socket = connect(proxy.port, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise<void>((resolve) => {
      socket.on("data", (chunk) => {
        if (chunk.toString("latin1").startsWith("HTTP/1.1 200")) resolve();
      });
      socket.once("connect", () =>
        socket.write(
          `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n${proxy.authorization}\r\n`,
        ),
      );
    });
    await proxy.close();
    expect(proxy.proxy.stateForTesting()).toEqual({
      connections: 0,
      pendingDeadlines: 0,
    });
    await new Promise((resolve) => socket.once("close", resolve));
  });
});
