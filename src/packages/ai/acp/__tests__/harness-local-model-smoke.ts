/**
 * Disposable offline qualification, not a production launcher.
 * Requires operator-provisioned pi-acp, llama-server and a GGUF model.
 * Run in a network=none container; no downloads or real credentials are used.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AcpHarnessClient } from "../harness-client";

async function main() {
  const [executable, serverExecutable, model] = process.argv.slice(2);
  for (const value of [executable, serverExecutable, model])
    assert.ok(
      value?.startsWith("/"),
      "Pass absolute pi-acp, server and model paths",
    );
  assert.equal(process.platform, "linux");
  assert.ok(
    Object.values(networkInterfaces())
      .flat()
      .every((entry) => entry?.internal),
    "Requires a loopback-only network namespace",
  );
  assert.equal(
    (await readFile("/proc/net/route", "utf8")).trim().split("\n").length,
    1,
  );
  const home = await mkdtemp(join(tmpdir(), "acp-local-model-"));
  const cwd = join(home, "workspace");
  const config = join(home, ".pi", "agent");
  await mkdir(cwd);
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, "models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:18995/v1",
          api: "openai-completions",
          apiKey: "offline-placeholder",
          models: [
            {
              id: "local-qwen",
              name: "Local Qwen",
              reasoning: false,
              input: ["text"],
              contextWindow: 16384,
              maxTokens: 128,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      defaultProvider: "local",
      defaultModel: "local-qwen",
      quietStartup: true,
    }),
  );
  const env = {
    HOME: home,
    PATH: `${dirname(executable)}:${dirname(process.execPath)}:/usr/bin:/bin`,
    LD_LIBRARY_PATH: `${dirname(serverExecutable)}:/opt/cocalc/runtime-lib`,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
  };
  const children: Array<{
    child: ChildProcessWithoutNullStreams;
    closed: Promise<void>;
  }> = [];
  function launch(command: string, args: string[]) {
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: "pipe",
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    children.push({ child, closed });
    let remaining = 4096;
    child.stderr.on("data", (chunk: Buffer) => {
      if (remaining > 0) process.stderr.write(chunk.subarray(0, remaining));
      remaining -= chunk.length;
    });
    child.on("error", (error) => process.stderr.write(`${error.message}\n`));
    return { child, closed };
  }
  async function stop(
    child: ChildProcessWithoutNullStreams,
    closed: Promise<void>,
  ) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await closed;
      return;
    }
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await closed;
  }
  let client: AcpHarnessClient | undefined;
  const timeout = setTimeout(() => {
    for (const { child, closed } of children) void stop(child, closed);
  }, 180_000);
  try {
    const server = launch(serverExecutable, [
      "-m",
      model,
      "--alias",
      "local-qwen",
      "--host",
      "127.0.0.1",
      "--port",
      "18995",
      "-c",
      "16384",
      "-t",
      "3",
      "--parallel",
      "1",
      "--jinja",
      "-n",
      "128",
    ]);
    server.child.stdout.resume();
    let healthy = false;
    for (let i = 0; i < 120; i++) {
      if (server.child.exitCode !== null)
        throw Error("Local inference server exited");
      try {
        healthy = (
          await fetch("http://127.0.0.1:18995/health", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        /* Loading model. */
      }
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(healthy, "Local model did not become ready");
    client = await AcpHarnessClient.start(
      {
        accountId: "disposable-probe",
        projectId: "disposable-project",
        profile: {
          version: 1,
          kind: "acp",
          id: "pi-local-model",
          revision: "pi-acp-0.0.33-pi-0.86.1",
          executable,
          args: [],
          cwd,
          executionPolicy: "full-access",
          credentialMode: "project-managed",
        },
      },
      async ({ profile }) => {
        const { child, closed } = launch(profile.executable, profile.args);
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          closed,
          stop: () => stop(child, closed),
        };
      },
    );
    await client.open();
    const messages: string[] = [];
    const result = await client.prompt(
      "Do not use any tools. In one short sentence, what is two plus two?",
      async (event) => {
        if (event.type === "message") messages.push(event.text);
      },
    );
    assert.ok(messages.join("").trim(), "Expected actual generated model text");
    assert.ok(["end_turn", "max_tokens"].includes(result.stopReason));
    process.stdout.write(
      JSON.stringify({
        ok: true,
        inference: "real-local-model",
        networkBoundary: "loopback-only",
        agent: client.capabilities.agentInfo,
        stopReason: result.stopReason,
        response: messages.join(""),
      }) + "\n",
    );
  } finally {
    clearTimeout(timeout);
    try {
      await client?.dispose();
    } finally {
      for (const { child, closed } of children) await stop(child, closed);
    }
  }
}
main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
