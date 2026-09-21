/**
 * Disposable-project qualification tool, not a production launcher.
 * Bundle with esbuild and run inside a project with pinned OpenCode or pi-acp.
 * Uses a loopback fake provider only; never supplies real provider credentials.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { connect } from "node:net";
import { join, dirname } from "node:path";
import assert from "node:assert/strict";
import { AcpHarnessClient } from "../harness-client";

async function verifyLoopbackOnly() {
  assert.equal(process.platform, "linux", "Offline probe requires Linux");
  assert.ok(
    Object.values(networkInterfaces())
      .flat()
      .every((entry) => entry?.internal),
    "Offline probe has a non-loopback interface",
  );
  assert.equal(
    (await readFile("/proc/net/route", "utf8")).trim().split("\n").length,
    1,
    "Offline probe has an IPv4 route",
  );
  // No application data is sent. Require a routing error, not merely a timeout.
  const outcome = await new Promise<string>((resolve) => {
    const socket = connect({ host: "1.1.1.1", port: 443 });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code ?? "unknown"),
    );
    socket.once("timeout", () => {
      socket.destroy();
      resolve("timeout");
    });
  });
  assert.equal(outcome, "ENETUNREACH");
}

async function main() {
  const executable = process.argv[2];
  const pi = process.argv[3] === "pi";
  if (!executable?.startsWith("/"))
    throw Error("Pass an absolute path to pinned OpenCode or pi-acp");
  const offline = process.argv.includes("--require-loopback-only");
  if (offline) await verifyLoopbackOnly();
  const home = await mkdtemp(join(tmpdir(), "cocalc-acp-smoke-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  let calls = 0;
  let writes = 0;
  const target = join(cwd, "acp-fixture.txt");
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    if (calls > 12) {
      res.writeHead(429).end();
      return;
    }
    const base = { id: "fixture", created: 1, model: "fixture" };
    if (request.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const writeTool = request.tools?.find(
        (tool: any) => tool.function?.name === "write",
      );
      if (writeTool && writes === 0) {
        writes++;
        const pathKey = writeTool.function.parameters?.properties?.filePath
          ? "filePath"
          : "path";
        const delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "fixture_write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  [pathKey]: target,
                  content: "ACP fixture file\n",
                }),
              },
            },
          ],
        };
        res.write(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      for (const delta of [
        { role: "assistant", content: "ACP " },
        { content: "local fixture verified." },
      ]) {
        res.write(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
      }
      res.write(
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "ACP local fixture verified.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  if (pi) {
    const config = join(home, ".pi", "agent");
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "fixture-not-a-real-key",
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 1000,
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({
        defaultProvider: "fixture",
        defaultModel: "fixture",
        quietStartup: true,
      }),
    );
  }
  let client: AcpHarnessClient | undefined;
  const timeout = setTimeout(() => {
    void client?.dispose();
    server.closeAllConnections();
  }, 90_000);
  try {
    client = await AcpHarnessClient.start(
      {
        accountId: "disposable-probe",
        projectId: "disposable-project",
        profile: {
          version: 1,
          kind: "acp",
          id: pi ? "pi-acp" : "opencode",
          revision: pi ? "0.0.33-pi-0.86.1" : "1.18.31",
          executable,
          args: pi ? [] : ["acp"],
          cwd,
          executionPolicy: "full-access",
          credentialMode: "project-managed",
        },
      },
      async ({ profile }) => {
        const child = spawn(profile.executable, profile.args, {
          cwd,
          detached: true,
          stdio: "pipe",
          env: {
            PATH: `${dirname(executable)}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
            HOME: home,
            XDG_CONFIG_HOME: join(home, "config"),
            XDG_DATA_HOME: join(home, "data"),
            XDG_CACHE_HOME: join(home, "cache"),
            XDG_STATE_HOME: join(home, "state"),
            OPENCODE_DISABLE_AUTOUPDATE: "true",
            OPENCODE_DISABLE_MODELS_FETCH: "true",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              model: "fixture/fixture",
              small_model: "fixture/fixture",
              enabled_providers: ["fixture"],
              permission: "allow",
              share: "disabled",
              provider: {
                fixture: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "Local fake provider",
                  options: {
                    baseURL: `http://127.0.0.1:${port}/v1`,
                    apiKey: "fixture-not-a-real-key",
                  },
                  models: {
                    fixture: {
                      name: "Fixture",
                      limit: { context: 32000, output: 1000 },
                    },
                  },
                },
              },
            }),
          },
        });
        const closed = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.once("error", () => resolve());
        });
        if (process.env.COCALC_ACP_SMOKE_DEBUG === "1") {
          // This probe uses an empty temporary HOME and fake credentials only.
          let remaining = 8192;
          child.stderr.on("data", (chunk: Buffer) => {
            if (remaining > 0)
              process.stderr.write(chunk.subarray(0, remaining));
            remaining -= chunk.length;
          });
          child.stdout.on("data", (chunk: Buffer) => {
            if (remaining > 0)
              process.stderr.write(chunk.subarray(0, remaining));
            remaining -= chunk.length;
          });
        }
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          closed,
          stop: async () => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
            }
            await closed;
          },
        };
      },
    );
    const capabilities = client.capabilities;
    await client.open();
    const controls = client.controls;
    await client.configure({});
    assert.equal(
      calls,
      0,
      "Discovery and session creation must not perform inference",
    );
    const messages: string[] = [];
    const result = await client.prompt(
      "Create acp-fixture.txt containing ACP fixture file, then greet me.",
      async (event) => {
        if (event.type === "message") messages.push(event.text);
      },
    );
    assert.equal(result.stopReason, "end_turn");
    assert.ok(calls > 0);
    assert.match(messages.join(""), /ACP local fixture verified/);
    assert.equal(await readFile(target, "utf8"), "ACP fixture file\n");
    const sessionId = client.sessionId;
    const followup: string[] = [];
    const second = await client.prompt("Greet me again.", async (event) => {
      if (event.type === "message") followup.push(event.text);
    });
    assert.equal(second.stopReason, "end_turn");
    assert.equal(client.sessionId, sessionId);
    assert.match(followup.join(""), /ACP local fixture verified/);
    process.stdout.write(
      JSON.stringify({
        ok: true,
        networkBoundary: offline ? "loopback-only-verified" : "not-checked",
        agent: capabilities.agentInfo,
        loadSession: capabilities.agentCapabilities?.loadSession,
        controls: {
          configOptions: controls.configOptions.map(({ id, options }) => ({
            id,
            choices: options.length,
          })),
          modes: controls.mode?.options.length ?? 0,
        },
        providerCalls: calls,
        fileWriteVerified: true,
        followupVerified: true,
        stopReason: result.stopReason,
        response: messages.join(""),
      }) + "\n",
    );
  } finally {
    clearTimeout(timeout);
    await client?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
void main().catch((error) => {
  process.stderr.write(`${error}\n`);
  process.exitCode = 1;
});
