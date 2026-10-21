/**
 * A reverse ssh tunnel owned by this process: 127.0.0.1:<projectPort> inside
 * the project reaches 127.0.0.1:<localPort> on this computer.
 *
 * Lifetime is tied to this process without any daemon or bookkeeping: ssh
 * runs `cat >/dev/null` in the project with its stdin connected to a pipe
 * held here.  However this process ends, the OS closes the pipe, the remote
 * `cat` sees EOF and exits, and ssh exits with it, taking the tunnel down.
 */
import { spawn, type ChildProcess } from "node:child_process";

// How OpenSSH reports that the project side could not listen (port in use,
// or the server refused the bind).
const FORWARD_REFUSED = /remote port forwarding failed|port forwarding failed/i;
// Errors that retrying cannot fix. Everything else (a dropped connection, a
// laptop asleep or offline, the project's ssh endpoint briefly refusing the
// websocket while it restarts) is retried for as long as the tunnel is
// wanted: the browser it serves stays open meanwhile.
const FATAL =
  /Permission denied|Host key verification failed|Bad (local|remote) forwarding specification/i;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000];
// A connection that stayed up this long counts as healthy, resetting backoff.
const HEALTHY_MS = 30_000;

export function reverseTunnelSshArgs({
  alias,
  projectPort,
  localPort,
  compress,
}: {
  alias: string;
  projectPort: number;
  localPort: number;
  compress?: boolean;
}): string[] {
  return [
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    ...(compress ? ["-C"] : []),
    // Loopback only: project sshd allows binds on all interfaces, and what
    // we forward (a browser's DevTools port) must only be reachable from
    // inside the project.
    "-R",
    `127.0.0.1:${projectPort}:127.0.0.1:${localPort}`,
    alias,
    // The remote end of the lifetime pipe (see above).
    "cat >/dev/null",
  ];
}

export interface ReverseTunnel {
  // Settles only if the tunnel gives up: the project refused the port, or
  // reconnecting keeps failing.
  failed: Promise<Error>;
  stop: () => Promise<void>;
}

export function startReverseTunnel({
  args,
  onStatus = () => {},
  spawnSsh = (sshArgs) =>
    spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
      // Own process group, so Ctrl-C reaches only us and we decide the
      // teardown order.
      detached: process.platform !== "win32",
      windowsHide: true,
    }),
  reconnectDelaysMs = RECONNECT_DELAYS_MS,
  maxQuickFailures = Infinity,
  jitter = 0.2,
}: {
  args: string[];
  onStatus?: (message: string) => void;
  spawnSsh?: (args: string[]) => ChildProcess;
  reconnectDelaysMs?: number[];
  /** Give up after this many consecutive connections that never became
   * healthy (default: never). */
  maxQuickFailures?: number;
  /** Each delay varies by up to this fraction, so many tunnels dropped at
   * once do not all come back at once. */
  jitter?: number;
}): ReverseTunnel {
  let child: ChildProcess | null = null;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let quickFailures = 0;
  let attempts = 0;
  let giveUp: (err: Error) => void = () => {};
  const failed = new Promise<Error>((resolve) => (giveUp = resolve));

  const connect = () => {
    if (stopping) return;
    const started = Date.now();
    attempts += 1;
    const first = attempts === 1;
    let stderr = "";
    const ssh = spawnSsh(args);
    child = ssh;
    // Never written: it only has to stay open (the lifetime pipe).
    ssh.stdin?.on("error", () => {});
    ssh.stderr?.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    ssh.on("error", (err) => {
      if (!stopping) {
        stopping = true;
        giveUp(new Error(`could not run ssh: ${err.message}`));
      }
    });
    ssh.on("close", () => {
      child = null;
      if (stopping) return;
      const detail = stderr.trim().split("\n").slice(-3).join(" ");
      // Refused at once: the port is taken. After a drop, though, the
      // project may still hold the old connection's port for a while.
      if (first && FORWARD_REFUSED.test(stderr)) {
        stopping = true;
        giveUp(
          new Error(
            `the project refused the tunnel (is the port already in use? try a different --port): ${detail}`,
          ),
        );
        return;
      }
      if (FATAL.test(stderr)) {
        stopping = true;
        giveUp(new Error(`ssh to the project failed: ${detail}`));
        return;
      }
      quickFailures =
        Date.now() - started >= HEALTHY_MS ? 0 : quickFailures + 1;
      if (quickFailures >= maxQuickFailures) {
        stopping = true;
        giveUp(new Error(`could not keep the ssh tunnel up: ${detail}`));
        return;
      }
      const base =
        reconnectDelaysMs[
          Math.min(Math.max(quickFailures - 1, 0), reconnectDelaysMs.length - 1)
        ];
      const delay = Math.round(base * (1 + jitter * (2 * Math.random() - 1)));
      onStatus(
        `Connection to the project dropped${detail ? ` (${detail})` : ""}; reconnecting in ${Math.round(delay / 1000)}s...`,
      );
      timer = setTimeout(connect, delay);
    });
  };
  connect();

  return {
    failed,
    stop: async () => {
      stopping = true;
      clearTimeout(timer);
      const ssh = child;
      if (!ssh || ssh.exitCode != null || ssh.signalCode != null) return;
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => ssh.kill("SIGKILL"), 3000);
        ssh.once("close", () => {
          clearTimeout(kill);
          resolve();
        });
        ssh.kill("SIGTERM");
      });
    },
  };
}
