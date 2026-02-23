import { Command } from "commander";

export type DaemonCommandDeps = {
  runLocalCommand: any;
  startDaemonProcess: any;
  daemonSocketPath: any;
  daemonPidPath: any;
  daemonLogPath: any;
  readDaemonPid: any;
  pingDaemon: any;
  sendDaemonRequest: any;
  daemonRequestId: any;
  serveDaemon: any;
};

export function registerDaemonCommand(program: Command, deps: DaemonCommandDeps): Command {
  const {
    runLocalCommand,
    startDaemonProcess,
    daemonSocketPath,
    daemonPidPath,
    daemonLogPath,
    readDaemonPid,
    pingDaemon,
    sendDaemonRequest,
    daemonRequestId,
    serveDaemon,
  } = deps;

  const daemon = program.command("daemon").description("manage local cocalc-cli daemon");

  daemon
    .command("start")
    .description("start daemon if not already running")
    .action(async (command: Command) => {
      await runLocalCommand(command, "daemon start", async () => {
        const result = await startDaemonProcess();
        return {
          socket: daemonSocketPath(),
          pid_file: daemonPidPath(),
          log_file: daemonLogPath(),
          started: result.started,
          already_running: !!result.already_running,
          pid: result.pid ?? readDaemonPid() ?? null,
        };
      });
    });

  daemon
    .command("status")
    .description("check daemon status")
    .action(async (command: Command) => {
      await runLocalCommand(command, "daemon status", async () => {
        const pid = readDaemonPid() ?? null;
        try {
          const pong = await pingDaemon();
          return {
            socket: daemonSocketPath(),
            pid_file: daemonPidPath(),
            log_file: daemonLogPath(),
            running: true,
            pid: pong.meta?.pid ?? pid,
            uptime_s: pong.meta?.uptime_s ?? null,
            started_at: pong.meta?.started_at ?? null,
          };
        } catch {
          return {
            socket: daemonSocketPath(),
            pid_file: daemonPidPath(),
            log_file: daemonLogPath(),
            running: false,
            pid,
          };
        }
      });
    });

  daemon
    .command("stop")
    .description("stop daemon")
    .action(async (command: Command) => {
      await runLocalCommand(command, "daemon stop", async () => {
        const pid = readDaemonPid() ?? null;
        try {
          const response = await sendDaemonRequest({
            request: {
              id: daemonRequestId(),
              action: "shutdown",
            },
            timeoutMs: 5_000,
          });
          return {
            stopped: !!response.ok,
            pid: response.meta?.pid ?? pid,
            socket: daemonSocketPath(),
          };
        } catch {
          if (pid != null) {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              // ignore
            }
          }
          return {
            stopped: true,
            pid,
            socket: daemonSocketPath(),
          };
        }
      });
    });

  daemon
    .command("serve")
    .description("internal daemon server")
    .option("--socket <path>", "daemon socket path")
    .action(async (opts: { socket?: string }) => {
      const socketPath = opts.socket?.trim() || daemonSocketPath();
      await serveDaemon(socketPath);
    });

  return daemon;
}
