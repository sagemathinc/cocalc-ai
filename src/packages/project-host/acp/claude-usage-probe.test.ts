import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.mock("./claude-subscription-registry", () => ({
  getClaudeSubscriptionCredential: jest.fn(),
}));
jest.mock("./claude-code-tools", () => ({ claudeCodeCliPath: jest.fn() }));
jest.mock("./claude-subscription-usage", () => ({
  writeClaudeUsageToHomeBay: jest.fn(),
}));

import {
  claudeUsageFromProbeOutput,
  claudeUsageProbeArgs,
  createClaudeUsageProbe,
} from "./claude-usage-probe";

const projectId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const credentialId = "33333333-3333-4333-8333-333333333333";
const now = Date.parse("2026-11-19T20:00:00Z");
const sec = (ms: number) => Math.round(ms / 1000);

// As Claude Code 2.1.300 prints them (from a run against a fake API).
function rateLimitLine(five: number, week: number) {
  return JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: sec(now + 96 * 3600_000),
      rateLimitType: "seven_day",
      overageStatus: "rejected",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: five, resetsAt: sec(now + 3 * 3600_000) },
        seven_day: { utilization: week, resetsAt: sec(now + 96 * 3600_000) },
      },
    },
    uuid: "f938d629-baff-4f60-aca2-3edcf1ec68d4",
    session_id: "c7363359-1796-4ea7-b0fc-ca238bacb49b",
  });
}
const resultLine = (extra: object = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    ...extra,
  });

test("the arguments ask for one turn with no tools or customizations", () => {
  const args = claudeUsageProbeArgs();
  expect(args.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
  expect(args).toContain("--safe-mode");
  expect(args).toContain("--strict-mcp-config");
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
});

test("the reading is the last report of each window", () => {
  const output = [
    '{"type":"system","subtype":"init"}',
    rateLimitLine(0.3, 0.6),
    "not json",
    rateLimitLine(0.37, 0.61),
    resultLine(),
  ].join("\n");
  expect(claudeUsageFromProbeOutput(output, now)).toEqual({
    observed_at: new Date(now).toISOString(),
    windows: {
      five_hour: { utilization: 0.37, resets_at: sec(now + 3 * 3600_000) },
      seven_day: { utilization: 0.61, resets_at: sec(now + 96 * 3600_000) },
    },
  });
  expect(claudeUsageFromProbeOutput(resultLine(), now)).toBeUndefined();
});

function setup(output: string | (() => Promise<string>)) {
  const saved: any[] = [];
  const homes: string[] = [];
  const run = jest.fn(async ({ home, token, args }) => {
    homes.push(home);
    expect(token).toBe("sk-ant-oat01-test");
    expect(args).toEqual(claudeUsageProbeArgs());
    return typeof output === "string" ? output : await output();
  });
  const probe = createClaudeUsageProbe({
    getToken: async () => "sk-ant-oat01-test",
    cliPath: async () => "/opt/claude",
    run,
    save: async (options) => {
      saved.push(options);
    },
    timeoutMs: 1000,
  });
  return { probe, run, saved, homes };
}

test("a check saves the reading for the credential and removes its home", async () => {
  const { probe, saved, homes } = setup(
    [rateLimitLine(0.37, 0.61), resultLine()].join("\n"),
  );
  const result = await probe({ projectId, accountId, credentialId });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ projectId, accountId, credentialId });
  expect(saved[0].usage.windows.seven_day.utilization).toBe(0.61);
  expect(result.observed_at).toBe(saved[0].usage.observed_at);
  expect(homes).toHaveLength(1);
  expect((await readdir(tmpdir())).includes(homes[0].split("/").pop()!)).toBe(
    false,
  );
});

test("without a reading the check fails with Claude's error and saves nothing", async () => {
  const { probe, saved } = setup(
    resultLine({
      subtype: "error_during_execution",
      is_error: true,
      result: "Invalid API key",
    }),
  );
  await expect(probe({ projectId, accountId, credentialId })).rejects.toThrow(
    /error_during_execution: Invalid API key/,
  );
  expect(saved).toEqual([]);
});

test("one check per subscription at a time, and at most two at once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { probe, run } = setup(async () => {
    await gate;
    return rateLimitLine(0.1, 0.2);
  });
  const first = probe({ projectId, accountId, credentialId });
  const same = probe({ projectId, accountId, credentialId });
  const other = probe({
    projectId,
    accountId,
    credentialId: "44444444-4444-4444-8444-444444444444",
  });
  await expect(
    probe({
      projectId,
      accountId,
      credentialId: "55555555-5555-4555-8555-555555555555",
    }),
  ).rejects.toThrow(/other Claude usage checks are running/);
  release();
  await Promise.all([first, same, other]);
  expect(run).toHaveBeenCalledTimes(2);
});

test("ids must be UUIDs", async () => {
  const { probe, run } = setup(rateLimitLine(0.1, 0.2));
  await expect(
    probe({ projectId: "x", accountId, credentialId }),
  ).rejects.toThrow(/invalid/);
  expect(run).not.toHaveBeenCalled();
});

// With a Claude Code binary (COCALC_TEST_CLAUDE_BIN), the real process
// against a fake Anthropic API: what the check sends and reads.
const describeCli = process.env.COCALC_TEST_CLAUDE_BIN
  ? describe
  : describe.skip;

describeCli("with Claude Code", () => {
  let server: Server;
  let dir: string;
  const requests: any[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-probe-test-"));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        requests.push({
          url: req.url,
          auth: req.headers.authorization,
          ...parsed,
        });
        const t = Math.floor(Date.now() / 1000);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.37",
          "anthropic-ratelimit-unified-5h-reset": String(t + 3 * 3600),
          "anthropic-ratelimit-unified-7d-utilization": "0.61",
          "anthropic-ratelimit-unified-7d-reset": String(t + 4 * 86400),
          "anthropic-ratelimit-unified-representative-claim": "seven_day",
          "anthropic-ratelimit-unified-reset": String(t + 4 * 86400),
        });
        const ev = (type: string, data: object) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
          );
        ev("message_start", {
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: parsed.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 12, output_tokens: 1 },
          },
        });
        ev("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        });
        ev("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", {
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        });
        ev("message_stop", {});
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });
  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("one tool-less Haiku request; both windows saved", async () => {
    const port = (server.address() as any).port;
    // The fake API stands in for Anthropic's (the check itself never sets
    // a base URL).
    const wrapper = join(dir, "claude");
    await writeFile(
      wrapper,
      `#!/bin/sh\nANTHROPIC_BASE_URL=http://127.0.0.1:${port} exec ${process.env.COCALC_TEST_CLAUDE_BIN} "$@"\n`,
    );
    await chmod(wrapper, 0o755);
    const saved: any[] = [];
    const probe = createClaudeUsageProbe({
      getToken: async () => "sk-ant-oat01-placeholderplaceholderplaceholder",
      cliPath: async () => wrapper,
      save: async (options) => {
        saved.push(options);
      },
    });
    await probe({ projectId, accountId, credentialId });
    const messages = requests.filter((r) => r.url?.startsWith("/v1/messages"));
    expect(messages).toHaveLength(1);
    expect(messages[0].model).toMatch(/haiku/);
    expect(messages[0].tools ?? []).toEqual([]);
    expect(messages[0].auth).toBe(
      "Bearer sk-ant-oat01-placeholderplaceholderplaceholder",
    );
    expect(saved[0].usage.windows).toEqual({
      five_hour: { utilization: 0.37, resets_at: expect.any(Number) },
      seven_day: { utilization: 0.61, resets_at: expect.any(Number) },
    });
  }, 60_000);
});
