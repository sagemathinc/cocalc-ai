import { connect } from "node:net";
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

afterAll(async () => {
  await shutdownClaudeRestrictedEgressForTesting();
});

beforeEach(() => {
  mockGetProject.mockReset();
  delete process.env.COCALC_CLAUDE_EGRESS_PROXY_HOST;
});

test("allows only exact Anthropic TLS targets", () => {
  for (const host of [
    "api.anthropic.com",
    "platform.claude.com",
    "claude.ai",
    "mcp-proxy.anthropic.com",
  ])
    expect(isAllowedClaudeEgressTarget(`${host}:443`)).toBe(true);
  for (const target of [
    "api.anthropic.com:80",
    "api.anthropic.com.evil.test:443",
    "http-intake.logs.us5.datadoghq.com:443",
    "storage.googleapis.com:443",
    "api.openai.com:443",
    "github.com:443",
  ])
    expect(isAllowedClaudeEgressTarget(target)).toBe(false);
});

test("projects with internet access get no proxy", async () => {
  mockGetProject.mockReturnValue({ run_quota: { network: true } });
  await expect(startClaudeRestrictedEgress({ projectId })).resolves.toBe(
    undefined,
  );
});

test("projects without internet access reach only Anthropic through the proxy", async () => {
  mockGetProject.mockReturnValue({ run_quota: { network: false } });
  const egress = await startClaudeRestrictedEgress({ projectId });
  try {
    const proxyUrl = egress!.env.HTTPS_PROXY;
    expect(egress!.env.https_proxy).toBe(proxyUrl);
    expect(new URL(proxyUrl).hostname).toBe("host.containers.internal");
    expect(new URL(proxyUrl).username).toBe("cocalc-claude");
    // The CoCalc API stays direct.
    expect(egress!.env.NO_PROXY).toContain("host.containers.internal");
    await expect(connectStatus(proxyUrl, "github.com:443")).resolves.toContain(
      "403",
    );
  } finally {
    egress?.close();
  }
  // A closed session's credential no longer opens tunnels.
  await expect(
    connectStatus(egress!.env.HTTPS_PROXY, "api.anthropic.com:443"),
  ).resolves.toContain("407");
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

test("the host address can be configured", () => {
  process.env.COCALC_CLAUDE_EGRESS_PROXY_HOST = "10.9.8.7";
  expect(projectHostAddress()).toBe("10.9.8.7");
});
