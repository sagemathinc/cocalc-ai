// Run after package build with CLAUDE_AGENT_ACP_BIN pointing to the pinned adapter.
// Uses only local fake providers and generated fixture credentials.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, mkdir, writeFile, rm, access } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createServer } = require("node:http");
const { PassThrough } = require("node:stream");
const { createInterface } = require("node:readline");
const { pinClaudeProvider } = require("../dist/acp/qualified-harness-entry");
const {
  CLAUDE_CODE_QUALIFICATION,
} = require("@cocalc/util/ai/qualified-harnesses");
const { claudeAccountApiKeySessionMeta } = require("@cocalc/ai/acp/harness");

test(
  "pinned adapter ignores user/project/local credential-routing overrides",
  {
    skip: !process.env.CLAUDE_AGENT_ACP_BIN,
    timeout: 60000,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-provider-test-"));
    const project = join(home, "project");
    const marker = join(home, "helper-called");
    let selectedRequests = 0;
    let wrongRequests = 0;
    const wrongPaths = [];
    let observeRoute;
    const routeObserved = new Promise((resolve) => {
      observeRoute = resolve;
    });
    const selected = createServer((req, res) => {
      if (req.url?.startsWith("/v1/messages")) {
        selectedRequests++;
        observeRoute();
      }
      req.resume();
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "authentication_error",
            message: "local qualification fixture",
          },
        }),
      );
    });
    const wrong = createServer((req, res) => {
      wrongRequests++;
      wrongPaths.push(req.url);
      observeRoute();
      req.resume();
      res.writeHead(401);
      res.end();
    });
    await new Promise((resolve) => selected.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => wrong.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${selected.address().port}`;
    const wrongUrl = `http://127.0.0.1:${wrong.address().port}`;
    const config = {
      env: {
        ANTHROPIC_BASE_URL: wrongUrl,
        ANTHROPIC_API_KEY: "fixture-wrong-key",
        ANTHROPIC_AUTH_TOKEN: "fixture-wrong-token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
      },
      apiKeyHelper: `touch '${marker}'; printf fixture-helper-key`,
    };
    await mkdir(join(project, ".claude"), { recursive: true });
    for (const file of [
      join(home, "settings.json"),
      join(project, ".claude/settings.json"),
      join(project, ".claude/settings.local.json"),
    ])
      await writeFile(file, JSON.stringify(config));
    const child = spawn(
      process.env.CLAUDE_AGENT_ACP_BIN,
      ["--hide-claude-auth"],
      {
        detached: true,
        cwd: project,
        env: {
          HOME: home,
          CLAUDE_CONFIG_DIR: home,
          PATH: process.env.PATH,
          NO_BROWSER: "1",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: "cocalc-credential-relay",
        },
        stdio: "pipe",
      },
    );
    const closed = once(child, "close");
    child.stderr.resume();
    const output = new PassThrough();
    const lines = createInterface({ input: output });
    let nextId = 0;
    const pending = new Map();
    const timers = new Set();
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        callback(message);
      }
    });
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`${method} timed out`));
        }, 30000);
        timers.add(timer);
        pending.set(id, (message) => {
          clearTimeout(timer);
          timers.delete(timer);
          resolve(message);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    try {
      await pinClaudeProvider(child, baseUrl, output);
      const initialized = await request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "cocalc-fixture", version: "1" },
        clientCapabilities: {},
      });
      assert.equal(
        initialized.result?.agentInfo?.version,
        CLAUDE_CODE_QUALIFICATION.package.version,
      );
      const session = await request("session/new", {
        cwd: project,
        mcpServers: [],
        _meta: claudeAccountApiKeySessionMeta(),
      });
      assert.ok(session.result?.sessionId, JSON.stringify(session.error));
      const prompt = request("session/prompt", {
        sessionId: session.result.sessionId,
        prompt: [{ type: "text", text: "Reply with OK; do not use tools." }],
      });
      await Promise.race([routeObserved, prompt]);
      assert.ok(selectedRequests > 0, "inference must use the selected route");
      assert.equal(
        wrongRequests,
        0,
        `settings must not redirect requests: ${wrongPaths.join(", ")}`,
      );
      await assert.rejects(access(marker), { code: "ENOENT" });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
      await closed;
      lines.close();
      selected.closeAllConnections();
      wrong.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => selected.close(resolve)),
        new Promise((resolve) => wrong.close(resolve)),
      ]);
      await rm(home, { recursive: true, force: true });
    }
  },
);
