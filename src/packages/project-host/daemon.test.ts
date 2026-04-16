import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DEBUG_FILE ??= path.join(
  os.tmpdir(),
  "cocalc-project-host-daemon-test.log",
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  __test__,
  ensureDaemon,
  ensureHostAgent,
  startDaemon,
  startHostAgent,
  stopDaemon,
} = require("./daemon");

describe("project-host daemon stop", () => {
  const originalEnv = { ...process.env };
  let runtimeDir: string;

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "0";
    runtimeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-runtime-"),
    );
    process.env.COCALC_PODMAN_RUNTIME_DIR = runtimeDir;
    process.env.DEBUG_FILE = path.join(runtimeDir, "debug.log");
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

  it("does nothing when the daemon is healthy", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    const pidPath = path.join(dataDir, "daemon.pid");
    fs.writeFileSync(pidPath, "7373");
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";

    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      expect(pid).toBe(7373);
      if (signal === 0 || signal === undefined) {
        return true;
      }
      throw new Error(`unexpected signal ${signal}`);
    }) as typeof process.kill);
    const healthSpy = jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockReturnValue({ status: 0 } as any);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    ensureDaemon(0);

    expect(healthSpy).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(7373, 0);
    expect(killSpy).not.toHaveBeenCalledWith(7373, "SIGTERM");
    expect(logSpy).toHaveBeenCalledWith("project-host healthy (pid 7373)");
  });

  it("starts a separate host-agent process", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;

    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockReturnValue({ pid: 7878, unref: () => {} } as any);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    startHostAgent(0);

    expect(spawnSpy).toHaveBeenCalledWith(
      process.execPath,
      [path.join(__dirname, "dist/main.js"), "--index", "0"],
      expect.objectContaining({
        env: expect.objectContaining({
          COCALC_PROJECT_HOST_AGENT: "1",
          COCALC_PROJECT_HOST_AGENT_INDEX: "0",
        }),
        detached: true,
      }),
    );
    expect((spawnSpy.mock.calls[0]?.[2] as any)?.env).not.toHaveProperty(
      "COCALC_PROJECT_HOST_CONAT_ROUTER_URL",
    );
    expect(fs.readFileSync(path.join(dataDir, "host-agent.pid"), "utf8")).toBe(
      "7878",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "project-host host-agent started (pid 7878); log=" +
        path.join(dataDir, "host-agent.log"),
    );
  });

  it("preserves an explicitly configured external router URL for host-agent", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL = "https://router.example";

    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockReturnValue({ pid: 7878, unref: () => {} } as any);

    startHostAgent(0);

    expect((spawnSpy.mock.calls[0]?.[2] as any)?.env).toMatchObject({
      COCALC_PROJECT_HOST_CONAT_ROUTER_URL: "https://router.example",
      COCALC_PROJECT_HOST_AGENT: "1",
    });
  });

  it("ensureHostAgent treats a running agent as healthy without a second reconcile", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    const agentPidPath = path.join(dataDir, "host-agent.pid");
    const pidPath = path.join(dataDir, "daemon.pid");
    fs.writeFileSync(agentPidPath, "7374");
    fs.writeFileSync(pidPath, "7373");
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";

    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === 7374) {
        if (signal === 0 || signal === undefined) {
          return true;
        }
        throw new Error(`unexpected signal ${signal}`);
      }
      if (pid === 7373) {
        if (signal === 0 || signal === undefined) {
          return true;
        }
        throw new Error(`unexpected signal ${signal}`);
      }
      throw new Error(`unexpected pid ${pid}`);
    }) as typeof process.kill);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    ensureHostAgent(0);

    expect(killSpy).toHaveBeenCalledWith(7374, 0);
    expect(killSpy).not.toHaveBeenCalledWith(7373, 0);
    expect(logSpy).toHaveBeenCalledWith(
      "project-host host-agent healthy (pid 7374)",
    );
  });

  it("does not treat a host-agent process as a stray project-host", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";

    const realReaddirSync = fs.readdirSync;
    const realReadFileSync = fs.readFileSync;
    jest.spyOn(fs, "readdirSync").mockImplementation(((
      file: any,
      opts?: any,
    ) => {
      if (file === "/proc") {
        return [{ name: "111", isDirectory: () => true }] as any;
      }
      return (realReaddirSync as any)(file, opts);
    }) as typeof fs.readdirSync);
    jest.spyOn(fs, "readFileSync").mockImplementation(((
      file: any,
      options?: any,
    ) => {
      if (file === "/proc/111/cmdline") {
        return Buffer.from(
          "node\u0000/opt/cocalc/project-host/bundles/cur/main/index.js\u0000--index\u00000\u0000",
        ) as any;
      }
      if (file === "/proc/111/environ") {
        return Buffer.from(
          `COCALC_DATA=${dataDir}\u0000COCALC_PROJECT_HOST_AGENT=1\u0000COCALC_PROJECT_HOST_AGENT_INDEX=0\u0000`,
        ) as any;
      }
      return (realReadFileSync as any)(file, options);
    }) as typeof fs.readFileSync);

    expect(__test__.matchingProjectHostPids(dataDir, 9002)).toEqual([]);
  });

  it("treats zombie processes as not running", () => {
    const realReadFileSync = fs.readFileSync;
    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      expect(pid).toBe(111);
      expect(signal).toBe(0);
      return true;
    }) as typeof process.kill);
    jest.spyOn(fs, "readFileSync").mockImplementation(((
      file: any,
      options?: any,
    ) => {
      if (file === "/proc/111/status") {
        return Buffer.from("Name:\tnode\nState:\tZ (zombie)\n") as any;
      }
      return (realReadFileSync as any)(file, options);
    }) as typeof fs.readFileSync);

    expect(__test__.isRunning(111)).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(111, 0);
  });

  it("preserves managed router and persist while recovering project-host under host-agent supervision", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "1";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST = "1";
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST;

    fs.writeFileSync(path.join(dataDir, "conat-router.pid"), "1111");
    fs.writeFileSync(path.join(dataDir, "conat-persist.pid"), "2222");

    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (pid === 1111 || pid === 2222) {
        expect(signal).toBe(0);
        return true;
      }
      throw new Error(`unexpected pid ${pid}`);
    }) as typeof process.kill);
    const healthSpy = jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockReturnValue({ status: 0 } as any);
    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockReturnValue({ pid: 3333, unref: () => {} } as any);

    ensureDaemon(0, {
      quietHealthy: true,
      preserveManagedAuxiliaryDaemons: true,
    });

    expect(healthSpy).toHaveBeenCalled();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect((spawnSpy.mock.calls[0]?.[2] as any)?.env).not.toHaveProperty(
      "COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON",
    );
    expect((spawnSpy.mock.calls[0]?.[2] as any)?.env).not.toHaveProperty(
      "COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON",
    );
    expect(killSpy).toHaveBeenCalledWith(1111, 0);
    expect(killSpy).toHaveBeenCalledWith(2222, 0);
    expect(killSpy).not.toHaveBeenCalledWith(1111, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(2222, "SIGTERM");
    expect(fs.readFileSync(path.join(dataDir, "daemon.pid"), "utf8")).toBe(
      "3333",
    );
  });

  it("treats start as idempotent when the daemon is already healthy", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    const pidPath = path.join(dataDir, "daemon.pid");
    fs.writeFileSync(pidPath, "7474");
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";

    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      expect(pid).toBe(7474);
      if (signal === 0 || signal === undefined) {
        return true;
      }
      throw new Error(`unexpected signal ${signal}`);
    }) as typeof process.kill);
    const healthSpy = jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockReturnValue({ status: 0 } as any);
    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockReturnValue({ pid: 9494, unref: () => {} } as any);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    startDaemon(0);

    expect(healthSpy).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(7474, 0);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "project-host already running and healthy (pid 7474); leaving it running.",
    );
    expect(fs.existsSync(pidPath)).toBe(true);
  });

  it("starts a managed conat router before project-host in external router mode", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "1";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST = "0";
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST;

    jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockReturnValue({ status: 0 } as any);
    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockImplementation(((_command: any, _args: any, opts?: any) => {
        const env = opts?.env ?? {};
        if (env.COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON === "1") {
          return { pid: 1111, unref: () => {} } as any;
        }
        return { pid: 2222, unref: () => {} } as any;
      }) as typeof __test__.processRuntime.spawn);

    startDaemon(0);

    expect(spawnSpy).toHaveBeenCalledTimes(2);
    expect((spawnSpy.mock.calls[0]?.[2] as any)?.env).toMatchObject({
      COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON: "1",
      HOST: "127.0.0.1",
      PORT: "9102",
    });
    expect((spawnSpy.mock.calls[1]?.[2] as any)?.env).not.toHaveProperty(
      "COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON",
    );
    expect(
      fs.readFileSync(path.join(dataDir, "conat-router.pid"), "utf8"),
    ).toBe("1111");
    expect(fs.readFileSync(path.join(dataDir, "daemon.pid"), "utf8")).toBe(
      "2222",
    );
  });

  it("starts managed conat persist after router and before project-host", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "1";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST = "1";
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST;

    jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockReturnValue({ status: 0 } as any);
    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockImplementation(((_command: any, _args: any, opts?: any) => {
        const env = opts?.env ?? {};
        if (env.COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON === "1") {
          return { pid: 1111, unref: () => {} } as any;
        }
        if (env.COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON === "1") {
          return { pid: 2222, unref: () => {} } as any;
        }
        return { pid: 3333, unref: () => {} } as any;
      }) as typeof __test__.processRuntime.spawn);

    startDaemon(0);

    expect(spawnSpy).toHaveBeenCalledTimes(3);
    expect((spawnSpy.mock.calls[0]?.[2] as any)?.env).toMatchObject({
      COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON: "1",
      PORT: "9102",
    });
    expect((spawnSpy.mock.calls[1]?.[2] as any)?.env).toMatchObject({
      COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON: "1",
      PORT: "9202",
    });
    expect((spawnSpy.mock.calls[2]?.[2] as any)?.env).not.toHaveProperty(
      "COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON",
    );
    expect(
      fs.readFileSync(path.join(dataDir, "conat-router.pid"), "utf8"),
    ).toBe("1111");
    expect(
      fs.readFileSync(path.join(dataDir, "conat-persist.pid"), "utf8"),
    ).toBe("2222");
    expect(fs.readFileSync(path.join(dataDir, "daemon.pid"), "utf8")).toBe(
      "3333",
    );
  });

  it("does not propagate host-agent env markers to managed children", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "1";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST = "1";
    process.env.COCALC_PROJECT_HOST_AGENT = "1";
    process.env.COCALC_PROJECT_HOST_AGENT_INDEX = "0";
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST;

    jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockReturnValue({ status: 0 } as any);
    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockImplementation(((_command: any, _args: any, opts?: any) => {
        const env = opts?.env ?? {};
        if (env.COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON === "1") {
          return { pid: 1111, unref: () => {} } as any;
        }
        if (env.COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON === "1") {
          return { pid: 2222, unref: () => {} } as any;
        }
        return { pid: 3333, unref: () => {} } as any;
      }) as typeof __test__.processRuntime.spawn);

    startDaemon(0);

    for (const call of spawnSpy.mock.calls) {
      expect((call[2] as any)?.env).not.toHaveProperty(
        "COCALC_PROJECT_HOST_AGENT",
      );
      expect((call[2] as any)?.env).not.toHaveProperty(
        "COCALC_PROJECT_HOST_AGENT_INDEX",
      );
    }
  });

  it("defaults project-host bootstrap to managed external router and persist", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    delete process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER;
    delete process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST;

    jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockReturnValue({ status: 0 } as any);
    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockImplementation(((_command: any, _args: any, opts?: any) => {
        const env = opts?.env ?? {};
        if (env.COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON === "1") {
          return { pid: 3333, unref: () => {} } as any;
        }
        if (env.COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON === "1") {
          return { pid: 4444, unref: () => {} } as any;
        }
        return { pid: 5555, unref: () => {} } as any;
      }) as typeof __test__.processRuntime.spawn);

    startDaemon(0);

    expect(spawnSpy).toHaveBeenCalledTimes(3);
    expect((spawnSpy.mock.calls[0]?.[2] as any)?.env).toMatchObject({
      COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER: "1",
      COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST: "1",
      COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON: "1",
      HOST: "127.0.0.1",
      PORT: "9102",
    });
    expect((spawnSpy.mock.calls[1]?.[2] as any)?.env).toMatchObject({
      COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER: "1",
      COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST: "1",
      COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON: "1",
      HOST: "127.0.0.1",
      PORT: "9202",
    });
    expect(
      fs.readFileSync(path.join(dataDir, "conat-router.pid"), "utf8"),
    ).toBe("3333");
    expect(
      fs.readFileSync(path.join(dataDir, "conat-persist.pid"), "utf8"),
    ).toBe("4444");
    expect(fs.readFileSync(path.join(dataDir, "daemon.pid"), "utf8")).toBe(
      "5555",
    );
  });

  it("stops the managed conat router when stopping project-host", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    fs.writeFileSync(path.join(dataDir, "daemon.pid"), "8181");
    fs.writeFileSync(path.join(dataDir, "conat-router.pid"), "8282");
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "1";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST = "0";
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST;
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_TIMEOUT_MS = "50";
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_POLL_MS = "1";

    const alive = new Set([8181, 8282]);
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

    expect(killSpy).toHaveBeenCalledWith(8181, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(8282, "SIGTERM");
    expect(fs.existsSync(path.join(dataDir, "daemon.pid"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "conat-router.pid"))).toBe(false);
  });

  it("stops the managed conat persist when stopping project-host", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    fs.writeFileSync(path.join(dataDir, "daemon.pid"), "8181");
    fs.writeFileSync(path.join(dataDir, "conat-router.pid"), "8282");
    fs.writeFileSync(path.join(dataDir, "conat-persist.pid"), "8383");
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "1";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST = "1";
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST;
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_TIMEOUT_MS = "50";
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_POLL_MS = "1";

    const alive = new Set([8181, 8282, 8383]);
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

    expect(killSpy).toHaveBeenCalledWith(8181, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(8282, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(8383, "SIGTERM");
    expect(fs.existsSync(path.join(dataDir, "daemon.pid"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "conat-router.pid"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "conat-persist.pid"))).toBe(false);
  });

  it("rejects external persist without external router", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "0";
    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST = "1";

    expect(() => startDaemon(0)).toThrow(
      "external conat persist mode requires external conat router mode",
    );
  });

  it("restarts the daemon when the pid is running but health checks fail", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    const pidPath = path.join(dataDir, "daemon.pid");
    fs.writeFileSync(pidPath, "8484");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(pidPath, old, old);
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_TIMEOUT_MS = "20";
    process.env.COCALC_PROJECT_HOST_DAEMON_STOP_POLL_MS = "1";

    let running = true;
    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0 || signal === undefined) {
        if (pid === 8484 && running) {
          return true;
        }
        throw new Error("not running");
      }
      if (pid === 8484 && signal === "SIGTERM") {
        running = false;
        return true;
      }
      throw new Error(`unexpected signal ${signal}`);
    }) as typeof process.kill);
    jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockReturnValue({ status: 1 } as any);
    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockReturnValue({ pid: 9494, unref: () => {} } as any);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    ensureDaemon(0);

    expect(warnSpy).toHaveBeenCalledWith(
      "project-host pid 8484 is running but unhealthy; restarting.",
    );
    expect(killSpy).toHaveBeenCalledWith(8484, "SIGTERM");
    expect(spawnSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "project-host started (pid 9494); log=" + path.join(dataDir, "log"),
    );
  });

  it("does not restart an unhealthy daemon during the startup grace window", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    const pidPath = path.join(dataDir, "daemon.pid");
    fs.writeFileSync(pidPath, "8585");
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";
    process.env.COCALC_PROJECT_HOST_DAEMON_STARTUP_GRACE_MS = "60000";

    const killSpy = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      expect(pid).toBe(8585);
      if (signal === 0 || signal === undefined) {
        return true;
      }
      throw new Error(`unexpected signal ${signal}`);
    }) as typeof process.kill);
    jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockReturnValue({ status: 1 } as any);
    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockReturnValue({ pid: 9595, unref: () => {} } as any);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    ensureDaemon(0);

    expect(killSpy).not.toHaveBeenCalledWith(8585, "SIGTERM");
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("project-host pid 8585 is still warming up"),
    );
  });

  it("uses localhost for health checks instead of the public internal url", () => {
    expect(
      __test__.healthCheckUrl(
        {
          HOST: "0.0.0.0",
          PORT: "9002",
          PROJECT_HOST_INTERNAL_URL: "https://host-example-lite2.cocalc.ai",
        },
        9002,
      ),
    ).toBe("http://127.0.0.1:9002/healthz");
  });

  it("honors an explicit daemon health url override", () => {
    expect(
      __test__.healthCheckUrl(
        {
          COCALC_PROJECT_HOST_DAEMON_HEALTH_URL: "http://127.0.0.1:9100/custom",
        },
        9002,
      ),
    ).toBe("http://127.0.0.1:9100/custom/healthz");
    expect(
      __test__.healthCheckUrl(
        {
          COCALC_PROJECT_HOST_DAEMON_HEALTH_URL:
            "http://127.0.0.1:9100/healthz",
        },
        9002,
      ),
    ).toBe("http://127.0.0.1:9100/healthz");
  });

  it("repairs podman pause-process state before starting the daemon", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-daemon-"),
    );
    process.env.COCALC_DATA = dataDir;
    process.env.PORT = "9002";

    const spawnSyncSpy = jest
      .spyOn(__test__.processRuntime, "spawnSync")
      .mockImplementation(((
        command: string,
        args: string[],
        options?: childProcess.SpawnSyncOptions,
      ) => {
        expect(command).toBe("podman");
        if (args.join(" ") === "ps -a") {
          const count = spawnSyncSpy.mock.calls.filter(
            ([, callArgs]) => (callArgs as string[]).join(" ") === "ps -a",
          ).length;
          if (count === 1) {
            expect(options?.encoding).toBe("utf8");
            expect(options?.env?.XDG_RUNTIME_DIR).toBe(runtimeDir);
            expect(options?.env?.CONTAINERS_CGROUP_MANAGER).toBe("cgroupfs");
            return {
              status: 125,
              stdout: "",
              stderr:
                'ERRO[0000] invalid internal status, try resetting the pause process with "podman system migrate": could not find any running process: no such process',
            } as any;
          }
          return { status: 0, stdout: "", stderr: "" } as any;
        }
        if (args.join(" ") === "system migrate") {
          return { status: 0, stdout: "stopped abc123\n", stderr: "" } as any;
        }
        throw new Error(`unexpected spawnSync args: ${args.join(" ")}`);
      }) as typeof __test__.processRuntime.spawnSync);
    const spawnSpy = jest
      .spyOn(__test__.processRuntime, "spawn")
      .mockReturnValue({ pid: 9797, unref: () => {} } as any);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    startDaemon(0);

    expect(
      spawnSyncSpy.mock.calls.map(([, args]) => (args as string[]).join(" ")),
    ).toEqual(["ps -a", "system migrate", "ps -a"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "podman reported stale pause-process state after restart; running `podman system migrate`.",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "podman rootless state repaired with `podman system migrate`.",
    );
    expect(spawnSpy).toHaveBeenCalled();
  });
});
