import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_BUNDLE_URL =
  process.env.COCALC_REFLECT_BUNDLE_URL ??
  "https://software.cocalc.ai/software/reflect-sync/bundle.mjs";

const DEFAULT_HOME = process.env.COCALC_REFLECT_HOME ?? path.join(
  os.homedir(),
  ".local",
  "share",
  "cocalc-plus",
  "reflect-sync",
);

const DEFAULT_BUNDLE_PATH = process.env.COCALC_REFLECT_BUNDLE_PATH ?? path.join(
  DEFAULT_HOME,
  "bundle.mjs",
);

async function downloadBundle(dest: string): Promise<void> {
  const res = await fetch(DEFAULT_BUNDLE_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to download reflect-sync bundle (${res.status} ${res.statusText})`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf, { mode: 0o644 });
}

async function ensureBundle(): Promise<string> {
  if (fs.existsSync(DEFAULT_BUNDLE_PATH)) {
    return DEFAULT_BUNDLE_PATH;
  }
  await downloadBundle(DEFAULT_BUNDLE_PATH);
  return DEFAULT_BUNDLE_PATH;
}

export async function runReflect(args: string[], opts?: { timeoutMs?: number }) {
  const bundle = await ensureBundle();
  const env = {
    ...process.env,
    REFLECT_HOME: DEFAULT_HOME,
    REFLECT_ENTRY: bundle,
  };
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout =
      opts?.timeoutMs != null
        ? setTimeout(() => {
            child.kill();
          }, opts.timeoutMs)
        : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code && code !== 0) {
        const message = stderr.trim() || `reflect-sync exited with ${code}`;
        reject(new Error(message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function runReflectJson<T>(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<T> {
  const raw = await runReflect(args, opts);
  if (!raw) {
    return [] as unknown as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse reflect-sync output: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
