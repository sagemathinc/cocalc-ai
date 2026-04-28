/*
Ssh server - manages how projects and their files are accessed via ssh.

This is a service that runs on the project-host. It:

- listens for incoming ssh connections from:
   - project
   - external users

- uses conat to determine what public keys grant access to a user
  of the above type

- if user is valid, it forwards the SSH session to the target project
  container's sshd.


./sshpiperd \
  -i server_host_key \
  --server-key-generate-mode notexist \
  ./sshpiperd-rest --url http://127.0.0.1:8443/auth


Security NOTE / TODO: It would be more secure to modify sshpiperd-rest
to support a UDP socket and use that instead, since we're running
the REST server on localhost.
*/

import { ensureProxyKey } from "./auth";
import { startProxyServer, createProxyHandlers } from "./proxy";
import { install, sshpiper } from "@cocalc/backend/sandbox/install";
import { secrets, sshServer } from "@cocalc/backend/data";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import getLogger from "@cocalc/backend/logger";
import getPort from "@cocalc/backend/get-port";
import { startManagedSshPluginServer } from "./ssh-plugin";
import { startManagedSshEdgeProxy } from "./ssh-edge-proxy";
import type { SshTarget } from "./ssh-target";
import type { Server as NetServer } from "node:net";
import type { Server as HttpServer } from "node:http";

const logger = getLogger("project-proxy:ssh:ssh-server");

export function secretsPath() {
  return join(secrets, "sshpiperd");
}

const children: ChildProcessWithoutNullStreams[] = [];

function removeChild(child: ChildProcessWithoutNullStreams) {
  const i = children.indexOf(child);
  if (i !== -1) {
    children.splice(i, 1);
  }
}

const FAILURE_PATTERNS = [
  /FATA/i,
  /failed to listen/i,
  /bind: address already in use/i,
];

async function waitForStartup(
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<void> {
  return await new Promise((resolve, reject) => {
    let done = false;
    let startupComplete = false;
    let stderrBuffer = "";
    let timer: NodeJS.Timeout;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (err) {
        reject(err);
      } else {
        startupComplete = true;
        resolve();
      }
    };

    const onStdout = (chunk: Buffer) => {
      logger.debug(chunk.toString());
    };

    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString();
      logger.debug(text);
      if (startupComplete) {
        return;
      }
      stderrBuffer += text;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        if (FAILURE_PATTERNS.some((pattern) => pattern.test(line))) {
          finish(
            new Error(
              `sshpiperd failed to start on port ${port}: ${line.trim()}`,
            ),
          );
          return;
        }
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (startupComplete) {
        return;
      }
      const reason =
        code !== null
          ? `code ${code}`
          : signal
            ? `signal ${signal}`
            : "unknown";
      finish(
        new Error(
          `sshpiperd exited before it was ready (port ${port}, ${reason})`,
        ),
      );
    };

    const onError = (err: Error) => {
      if (startupComplete) {
        return;
      }
      finish(err);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);

    timer = setTimeout(() => {
      finish();
    }, 5000);
  });
}

export async function init({
  authorizePublicKey,
  checkManagedSshAllowed,
  recordManagedSshEgress,
  port = sshServer.port,
  proxyHandlers,
  exitOnFail = true,
  hostKeyPath,
}: {
  authorizePublicKey: (opts: {
    target: SshTarget;
    public_key: Uint8Array;
    remote_addr: string;
  }) => Promise<{
    project_id: string;
    account_id?: string;
    ssh_user: string;
    port: number;
  }>;
  checkManagedSshAllowed: (opts: {
    project_id: string;
    account_id?: string;
  }) => Promise<{ allowed: true } | { allowed: false; message: string }>;
  recordManagedSshEgress: (opts: {
    project_id: string;
    account_id?: string;
    remote_addr: string;
    bytes: number;
    partial: boolean;
  }) => Promise<void> | void;
  port?: number;
  proxyHandlers?: boolean;
  exitOnFail?: boolean;
  hostKeyPath?: string;
}): Promise<{
  child;
  close: () => Promise<void>;
  projectProxyHandlers: HttpServer | ReturnType<typeof createProxyHandlers>;
  publicKey: string;
}> {
  logger.debug("init", { port, proxyHandlers });
  // ensure sshpiper is installed
  await install("sshpiper");
  const projectProxyHandlers = proxyHandlers
    ? createProxyHandlers()
    : await startProxyServer();
  const sshKey = await ensureProxyKey();
  const publicKey = sshKey.publicKey;
  const plugin = await startManagedSshPluginServer({
    proxy_private_key: sshKey.privateKey,
    authorizePublicKey: async ({ remote_addr, target, public_key }) => {
      return await authorizePublicKey({
        remote_addr,
        target,
        public_key,
      });
    },
  });
  const internalPort = await getPort();
  const hostKey = hostKeyPath ?? join(secretsPath(), "host_key");
  await mkdir(dirname(hostKey), { recursive: true });
  const args = [
    "-i",
    hostKey,
    "--address=127.0.0.1",
    `--port=${internalPort}`,
    "--log-level=warn",
    "--server-key-generate-mode",
    "notexist",
    "--allowed-proxy-addresses=127.0.0.1/32",
    "--allowed-proxy-addresses=::1/128",
    "grpc",
    `--endpoint=${plugin.endpoint}`,
    "--insecure",
  ];

  // sshpiperd-rest lives in a shared pnpm store; concurrent startups can hit
  // ETXTBSY if another process has it open for write. We retry once on that
  // specific error to avoid flakiness without masking real failures.
  const tryStart = async () => {
    logger.debug(`${sshpiper} ${args.join(" ")}`);
    const child = spawn(sshpiper, args);
    children.push(child);
    try {
      await waitForStartup(child, port);
      logger.debug("sshpiperd started", { port });
      return child;
    } catch (err) {
      removeChild(child);
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  let child;
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      child = await tryStart();
      break;
    } catch (err: any) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr.message || "";
      const isBusy = /text file busy/i.test(msg);
      if (isBusy && attempt === 0) {
        // Small randomized backoff then retry once.
        const delay = 50 + Math.floor(Math.random() * 150);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const message =
        lastErr instanceof Error
          ? lastErr.message
          : "unknown failure starting sshpiperd";
      logger.error(message);
      if (exitOnFail) {
        console.error(message);
        console.error("Shutting down.");
        process.exit(1);
      }
      throw lastErr;
    }
  }
  if (!child) {
    const message =
      lastErr?.message ?? "unknown failure starting sshpiperd after retries";
    logger.error(message);
    if (exitOnFail) {
      console.error(message);
      console.error("Shutting down.");
      process.exit(1);
    }
    throw lastErr ?? new Error(message);
  }

  let edgeProxy: NetServer | undefined;
  try {
    edgeProxy = await startManagedSshEdgeProxy({
      port,
      upstreamPort: internalPort,
      getIdentity: (remote_addr) => plugin.state.getSession(remote_addr),
      clearIdentity: (remote_addr) => plugin.state.clearSession(remote_addr),
      checkAllowed: async ({ project_id, account_id }) => {
        return await checkManagedSshAllowed({ project_id, account_id });
      },
      record: async ({
        project_id,
        account_id,
        remote_addr,
        bytes,
        partial,
      }) => {
        await recordManagedSshEgress({
          project_id,
          account_id,
          remote_addr,
          bytes,
          partial,
        });
      },
    });
  } catch (err) {
    removeChild(child);
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
    }
    await plugin.close();
    throw err;
  }

  const close = async () => {
    edgeProxy?.close();
    await plugin.close();
    removeChild(child);
    if (child.exitCode == null) {
      child.kill("SIGKILL");
    }
  };

  return { child, close, projectProxyHandlers, publicKey };
}

export function close() {
  for (const child of children) {
    if (child.exitCode == null) {
      child.kill("SIGKILL");
    }
  }
  children.length = 0;
}

// important because it kills all
// the processes that were spawned
process.once("exit", close);
["SIGINT", "SIGTERM", "SIGQUIT"].forEach((sig) => {
  process.once(sig, () => {
    process.exit();
  });
});
