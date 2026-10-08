import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import {
  isAllowedClaudeEgressTarget,
  projectHostAddress,
  shutdownClaudeRestrictedEgressForTesting,
  startClaudeRestrictedEgress,
} from "./claude-restricted-egress";

const mockGetProject = jest.fn();
jest.mock("../sqlite/projects", () => ({
  getProject: (...args) => mockGetProject(...args),
}));

const projectId = "1892b11a-6c63-4a92-988d-01dcddc0bc79";

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

async function plainHttpStatus(proxyUrl: string) {
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
        `GET http://host.containers.internal:9000/metrics HTTP/1.1\r\nHost: host.containers.internal:9000\r\nProxy-Authorization: Basic ${credential}\r\n\r\n`,
      );
    });
  });
}

afterAll(async () => {
  await shutdownClaudeRestrictedEgressForTesting();
});

beforeEach(() => {
  mockGetProject.mockReset();
  delete process.env.COCALC_CLAUDE_EGRESS_PROXY_HOST;
});

test("allows only exact Anthropic TLS targets", () => {
  for (const host of ["api.anthropic.com", "platform.claude.com", "claude.ai"])
    expect(isAllowedClaudeEgressTarget(`${host}:443`)).toBe(true);
  for (const target of [
    "api.anthropic.com:80",
    "api.anthropic.com.evil.test:443",
    "http-intake.logs.us5.datadoghq.com:443",
    "storage.googleapis.com:443",
    "api.openai.com:443",
    "github.com:443",
    "mcp-proxy.anthropic.com:443",
  ])
    expect(isAllowedClaudeEgressTarget(target)).toBe(false);
  expect(isAllowedClaudeEgressTarget("mcp-proxy.anthropic.com:443", true)).toBe(
    true,
  );
});

test("projects with internet access get no proxy", async () => {
  mockGetProject.mockReturnValue({ run_quota: { network: true } });
  await expect(startClaudeRestrictedEgress({ projectId })).resolves.toBe(
    undefined,
  );
});

test("a harness inside the project reaches only Anthropic", async () => {
  mockGetProject.mockReturnValue({ run_quota: { network: false } });
  // The project-side harness (harness-launcher) runs Claude Code with shell
  // tools: a public host would give project commands internet access.
  const egress = await startClaudeRestrictedEgress({ projectId });
  try {
    // Its CoCalc API calls stay direct.
    expect(egress!.env.NO_PROXY).toContain("host.containers.internal");
    expect(egress!.env.HTTP_PROXY).toBeUndefined();
    for (const target of ["example.com:443", "github.com:443"])
      await expect(
        connectStatus(egress!.env.HTTPS_PROXY, target),
      ).resolves.toContain("403");
  } finally {
    egress?.close();
  }
});

test("the subscription controller reaches Anthropic and public hosts, never local networks", async () => {
  mockGetProject.mockReturnValue({ run_quota: { network: false } });
  const egress = await startClaudeRestrictedEgress({
    projectId,
    publicHosts: true,
  });
  try {
    const proxyUrl = egress!.env.HTTPS_PROXY;
    expect(egress!.env.https_proxy).toBe(proxyUrl);
    expect(new URL(proxyUrl).hostname).toBe("host.containers.internal");
    expect(new URL(proxyUrl).username).toBe("cocalc-claude");
    // Every web request, plain HTTP and the host alias included, meets the
    // proxy's checks; only the container's own loopback is direct.
    expect(egress!.env.HTTP_PROXY).toBe(proxyUrl);
    expect(egress!.env.http_proxy).toBe(proxyUrl);
    expect(egress!.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(egress!.env.no_proxy).toBe("localhost,127.0.0.1,::1");
    await expect(plainHttpStatus(proxyUrl)).resolves.toContain("405");
    for (const target of [
      "localhost:443",
      "10.0.0.1:443",
      "169.254.169.254:443",
      "github.com:80",
      "mcp-proxy.anthropic.com..:443",
      "example..com:443",
    ])
      await expect(connectStatus(proxyUrl, target)).resolves.toContain("403");
    await expect(
      connectStatus(proxyUrl, "mcp-proxy.anthropic.com:443"),
    ).resolves.toContain("403");
  } finally {
    egress?.close();
  }
  // A closed session's credential no longer opens tunnels.
  await expect(
    connectStatus(egress!.env.HTTPS_PROXY, "api.anthropic.com:443"),
  ).resolves.toContain("407");
});

test("an env-proxy HTTP client in the controller cannot reach host services", async () => {
  mockGetProject.mockReturnValue({ run_quota: { network: false } });
  // A service on this host's own (non-loopback) address, like a metrics or
  // management endpoint that project containment allows locally.
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!address) return;
  const hits: string[] = [];
  const service = createHttpServer((request, response) => {
    hits.push(`${request.url}`);
    response.end("host-only");
  });
  await new Promise<void>((resolve) => service.listen(0, address, resolve));
  const port = (service.address() as { port: number }).port;
  const egress = await startClaudeRestrictedEgress({
    projectId,
    host: "127.0.0.1",
    publicHosts: true,
  });
  try {
    // Node's fetch with NODE_USE_ENV_PROXY selects proxies from these
    // variables the way Claude Code's EnvHttpProxyAgent does.
    const script = `
      const out = [];
      for (const url of process.argv.slice(1)) {
        try { const r = await fetch(url); out.push(r.status); }
        catch { out.push("failed"); }
      }
      console.log(JSON.stringify(out));`;
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          `http://${address}:${port}/plain`,
          `https://${address}:${port}/tls`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            NODE_USE_ENV_PROXY: "1",
            ...egress!.env,
          },
          timeout: 20_000,
        },
        (error, out) => (error ? reject(error) : resolve(out)),
      ),
    );
    // Plain HTTP is refused by the proxy (405; some Node versions report
    // that as a failed fetch); HTTPS to an IP literal is refused at CONNECT.
    // Neither reaches the host service.
    const [plain, tls] = JSON.parse(stdout);
    expect([405, "failed"]).toContain(plain);
    expect(tls).toBe("failed");
    expect(hits).toEqual([]);
  } finally {
    egress?.close();
    await new Promise((resolve) => service.close(resolve));
  }
});

test("the subscription controller addresses the proxy by host address", async () => {
  mockGetProject.mockReturnValue({ run_quota: { network: 0 } });
  const egress = await startClaudeRestrictedEgress({
    projectId,
    host: "10.1.2.3",
  });
  try {
    expect(new URL(egress!.env.HTTPS_PROXY).host).toMatch(/^10\.1\.2\.3:\d+$/);
  } finally {
    egress?.close();
  }
});

test("connector permission belongs to its session, not the shared listener", async () => {
  mockGetProject.mockReturnValue({ run_quota: { network: false } });
  const upstream = createServer((socket) => socket.resume());
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamPort = (upstream.address() as { port: number }).port;
  const originalConnect = connect;
  const connectMock = jest
    .spyOn(require("node:net"), "connect")
    .mockImplementation((port: number, hostname: string) =>
      originalConnect(
        port === 443 ? upstreamPort : port,
        port === 443 ? "127.0.0.1" : hostname,
      ),
    );
  const enabled = await startClaudeRestrictedEgress({
    projectId,
    claudeAiConnectors: true,
  });
  const disabled = await startClaudeRestrictedEgress({ projectId });
  try {
    expect(new URL(enabled!.env.HTTPS_PROXY).port).toBe(
      new URL(disabled!.env.HTTPS_PROXY).port,
    );
    await expect(
      connectStatus(enabled!.env.HTTPS_PROXY, "mcp-proxy.anthropic.com:443"),
    ).resolves.toContain("200");
    await expect(
      connectStatus(disabled!.env.HTTPS_PROXY, "mcp-proxy.anthropic.com:443"),
    ).resolves.toContain("403");
    enabled!.close();
    await expect(
      connectStatus(disabled!.env.HTTPS_PROXY, "api.anthropic.com:443"),
    ).resolves.toContain("200");
  } finally {
    enabled?.close();
    disabled?.close();
    connectMock.mockRestore();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("the host address can be configured", () => {
  process.env.COCALC_CLAUDE_EGRESS_PROXY_HOST = "10.9.8.7";
  expect(projectHostAddress()).toBe("10.9.8.7");
});
