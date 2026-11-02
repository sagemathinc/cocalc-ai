/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Against the real Codex binary (COCALC_TEST_CODEX_BIN, or the one CoCalc
// ships at /opt/cocalc/bin2/codex; skipped when neither exists): starting a
// thread writes CODEX_HOME/shell_snapshots/*.sh from the app-server's own
// environment, without any model call. A credential in that environment
// must not reach the snapshot.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHELL_ENVIRONMENT_EXCLUDE_CONFIG } from "./shell-snapshots";

const CODEX_BIN = [
  process.env.COCALC_TEST_CODEX_BIN,
  "/opt/cocalc/bin2/codex",
].find((path) => path && existsSync(path));

const describeCodex = CODEX_BIN ? describe : describe.skip;

const FAKE_KEY = "sk-synthetic-test-key-0123456789abcdef";
const FAKE_PROXY_TOKEN = "synthetic-egress-token-fedcba9876543210";
const FAKE_PROXY_URL = `http://cocalc-codex:${FAKE_PROXY_TOKEN}@host.containers.internal:43128`;

async function snapshotsAfterThreadStart(configArgs: string[]) {
  const home = await mkdtemp(join(tmpdir(), "codex-snapshot-home-"));
  const codexHome = join(home, ".codex");
  await mkdir(codexHome);
  const proc = spawn(
    CODEX_BIN!,
    [...configArgs, "app-server", "--listen", "stdio://"],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        CODEX_HOME: codexHome,
        SHELL: "/bin/bash",
        OPENAI_API_KEY: FAKE_KEY,
        HTTPS_PROXY: FAKE_PROXY_URL,
        https_proxy: FAKE_PROXY_URL,
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  try {
    let buffered = "";
    const responses = new Map<number, unknown>();
    proc.stdout!.on("data", (chunk) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (typeof message.id === "number") {
            responses.set(message.id, message);
          }
        } catch {}
      }
    });
    const send = (message: object) =>
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const until = async (check: () => Promise<boolean> | boolean) => {
      const deadline = Date.now() + 20_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "cocalc-test", version: "1" } },
    });
    await until(() => responses.has(1));
    send({ method: "initialized" });
    send({ id: 2, method: "thread/start", params: { cwd: home } });
    const dir = join(codexHome, "shell_snapshots");
    await until(async () => existsSync(dir) && (await readdir(dir)).length > 0);
    // The snapshot file is written whole, but give it a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const texts: string[] = [];
    for (const name of await readdir(dir)) {
      texts.push(await readFile(join(dir, name), "utf8"));
    }
    return texts;
  } finally {
    proc.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
}

describeCodex("Codex shell snapshots with a credential in the env", () => {
  jest.setTimeout(60_000);

  it("leak it without the exclusion (the reason for the exclusion)", async () => {
    const texts = await snapshotsAfterThreadStart([]);
    expect(texts.some((text) => text.includes(FAKE_KEY))).toBe(true);
    expect(texts.some((text) => text.includes(FAKE_PROXY_TOKEN))).toBe(true);
  });

  it("leave both the name and the value out with the exclusion", async () => {
    const texts = await snapshotsAfterThreadStart([
      "--config",
      SHELL_ENVIRONMENT_EXCLUDE_CONFIG,
    ]);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain("OPENAI_API_KEY");
      expect(text).not.toContain(FAKE_PROXY_TOKEN);
      expect(text).not.toMatch(/https_proxy/i);
    }
  });
});
