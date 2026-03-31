import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopDaemon } from "./daemon";

describe("project-host daemon stop", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("waits for SIGTERM exit before removing the pid file", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    const pidPath = path.join(dataDir, "daemon.pid");
    fs.writeFileSync(pidPath, "4242");
    process.env.COCALC_DATA = dataDir;
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_TIMEOUT_MS = "50";
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_POLL_MS = "1";

    let running = true;
    let checks = 0;
    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      expect(pid).toBe(4242);
      if (signal === 0 || signal === undefined) {
        checks += 1;
        if (checks >= 3) {
          running = false;
        }
        if (running) {
          return true;
        }
        throw new Error("not running");
      }
      if (signal === "SIGTERM") {
        return true;
      }
      throw new Error(`unexpected signal ${signal}`);
    }) as typeof process.kill);

    stopDaemon(0);

    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(4242, "SIGKILL");
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM does not stop the daemon", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    const pidPath = path.join(dataDir, "daemon.pid");
    fs.writeFileSync(pidPath, "5252");
    process.env.COCALC_DATA = dataDir;
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_TIMEOUT_MS = "5";
    process.env.COCALC_PROJECT_HOST_DAEMON_KILL_TIMEOUT_MS = "20";
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_POLL_MS = "1";

    let state: "running" | "killed" = "running";
    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      expect(pid).toBe(5252);
      if (signal === 0 || signal === undefined) {
        if (state === "running") {
          return true;
        }
        throw new Error("not running");
      }
      if (signal === "SIGTERM") {
        return true;
      }
      if (signal === "SIGKILL") {
        state = "killed";
        return true;
      }
      throw new Error(`unexpected signal ${signal}`);
    }) as typeof process.kill);

    stopDaemon(0);

    expect(killSpy).toHaveBeenCalledWith(5252, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(5252, "SIGKILL");
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it("cleans up stray project-host processes when the pid file is stale", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    const pidPath = path.join(dataDir, "daemon.pid");
    fs.writeFileSync(pidPath, "9999");
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.PROJECT_HOST_SSH_SERVER = "localhost:2222";
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_TIMEOUT_MS = "20";
    process.env.COCALC_PROJECT_HOST_DAEMON_KILL_TIMEOUT_MS = "20";
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_POLL_MS = "1";

    const realReadFileSync = fs.readFileSync;
    const realReaddirSync = fs.readdirSync;
    jest.spyOn(fs, "readdirSync").mockImplementation(((
      file: any,
      opts?: any,
    ) => {
      if (file === "/proc") {
        return [
          { name: "111", isDirectory: () => true },
          { name: "222", isDirectory: () => true },
          { name: "333", isDirectory: () => true },
        ] as any;
      }
      return (realReaddirSync as any)(file, opts);
    }) as typeof fs.readdirSync);
    jest.spyOn(fs, "readFileSync").mockImplementation(((
      file: any,
      options?: any,
    ) => {
      if (file === pidPath) {
        return "9999" as any;
      }
      if (file === "/proc/111/cmdline") {
        return Buffer.from(
          "node\u0000/opt/cocalc/project-host/bundles/old/main/index.js\u0000",
        ) as any;
      }
      if (file === "/proc/111/environ") {
        return Buffer.from(
          `COCALC_DATA=${dataDir}\u0000PORT=9002\u0000`,
        ) as any;
      }
      if (file === "/proc/222/cmdline") {
        return Buffer.from(
          "/opt/cocalc/tools/current/sshpiperd\u0000--port=2222\u0000",
        ) as any;
      }
      if (file === "/proc/222/environ") {
        return Buffer.from("") as any;
      }
      if (file === "/proc/333/cmdline") {
        return Buffer.from("node\u0000/something-else\u0000") as any;
      }
      if (file === "/proc/333/environ") {
        return Buffer.from(`COCALC_DATA=/other\u0000PORT=9003\u0000`) as any;
      }
      return (realReadFileSync as any)(file, options);
    }) as typeof fs.readFileSync);

    const alive = new Set([111, 222]);
    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 || signal === undefined) {
        if (alive.has(pid)) {
          return true;
        }
        throw new Error("not running");
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        alive.delete(pid);
        return true;
      }
      throw new Error(`unexpected signal ${signal}`);
    }) as typeof process.kill);

    stopDaemon(0);

    expect(killSpy).toHaveBeenCalledWith(111, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(222, "SIGTERM");
    expect(fs.existsSync(pidPath)).toBe(false);
  });
});
