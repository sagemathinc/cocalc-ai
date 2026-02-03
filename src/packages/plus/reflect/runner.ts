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

const DEFAULT_LAUNCHER_PATH =
  process.env.COCALC_REFLECT_LAUNCHER_PATH ??
  path.join(DEFAULT_HOME, "reflect-launch.sh");

function resolveNodeBinary(): string {
  const override = process.env.COCALC_REFLECT_NODE_PATH;
  if (override && fs.existsSync(override)) {
    return override;
  }
  const execBase = path.basename(process.execPath);
  if (execBase.startsWith("cocalc-plus")) {
    const sibling = path.join(path.dirname(process.execPath), "node");
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  }
  return process.execPath;
}

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

export async function ensureBundle(dest?: string): Promise<string> {
  const target = dest ?? DEFAULT_BUNDLE_PATH;
  if (fs.existsSync(target)) {
    return target;
  }
  await downloadBundle(target);
  return target;
}

async function ensureLauncher(nodeBin: string, bundle: string): Promise<string> {
  const content =
    `#!/usr/bin/env bash\n` +
    `set -e\n` +
    `NODE_BIN=${JSON.stringify(nodeBin)}\n` +
    `BUNDLE=${JSON.stringify(bundle)}\n` +
    `BASE="$(basename "$NODE_BIN")"\n` +
    `if [[ "$BASE" == cocalc-plus* ]]; then\n` +
    `  exec "$NODE_BIN" --run-reflect "$BUNDLE" -- "$@"\n` +
    `else\n` +
    `  exec "$NODE_BIN" "$BUNDLE" "$@"\n` +
    `fi\n`;
  try {
    if (fs.existsSync(DEFAULT_LAUNCHER_PATH)) {
      const existing = fs.readFileSync(DEFAULT_LAUNCHER_PATH, "utf8");
      if (existing === content) {
        return DEFAULT_LAUNCHER_PATH;
      }
    }
  } catch {
    // rewrite below
  }
  await mkdir(path.dirname(DEFAULT_LAUNCHER_PATH), { recursive: true });
  await writeFile(DEFAULT_LAUNCHER_PATH, content, { mode: 0o755 });
  try {
    fs.chmodSync(DEFAULT_LAUNCHER_PATH, 0o755);
  } catch {
    // ignore chmod failures
  }
  return DEFAULT_LAUNCHER_PATH;
}

export async function runReflect(args: string[], opts?: { timeoutMs?: number }) {
  const bundle = await ensureBundle();
  const nodeBin = resolveNodeBinary();
  const launcher = await ensureLauncher(nodeBin, bundle);
  const nodeBase = path.basename(nodeBin);
  const useSelfRunner =
    nodeBin === process.execPath && nodeBase.startsWith("cocalc-plus");
  const env = {
    ...process.env,
    REFLECT_HOME: DEFAULT_HOME,
    REFLECT_ENTRY: launcher,
  };
  return await new Promise<string>((resolve, reject) => {
    const childArgs = useSelfRunner
      ? ["--run-reflect", bundle, "--", ...args]
      : [bundle, ...args];
    const child = spawn(nodeBin, childArgs, {
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
