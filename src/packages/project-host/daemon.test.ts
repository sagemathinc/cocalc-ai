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
});
