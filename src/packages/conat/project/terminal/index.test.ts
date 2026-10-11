import {
  boundedTerminalHistory,
  mergeTerminalEnv0,
  terminalClient,
  terminalServer,
} from "./index";
import { EventEmitter } from "events";

describe("mergeTerminalEnv0", () => {
  it("bounds retained history for lightweight reconnects", () => {
    expect(boundedTerminalHistory("abcdef", 3)).toEqual({
      history: "def",
      omitted: true,
    });
    expect(boundedTerminalHistory("abc", 3)).toEqual({
      history: "abc",
      omitted: false,
    });
  });
  it("does not leak ambient COCALC_* vars into generic terminals", () => {
    const env = mergeTerminalEnv0({
      env0: {
        COCALC_CONTROL_DIR: "/tmp/control",
        COCALC_TERMINAL_FILENAME: "/tmp/test.term",
        PATH: "/custom/bin",
      },
      baseEnv: {
        HOME: "/home/test",
        PATH: "/usr/bin",
        COCALC_API_URL: "http://localhost:7000",
        COCALC_AGENT_TOKEN: "secret",
        COCALC_BEARER_TOKEN: "secret",
      },
    });

    expect(env).toMatchObject({
      HOME: "/home/test",
      PATH: "/custom/bin",
      COCALC_CONTROL_DIR: "/tmp/control",
      COCALC_TERMINAL_FILENAME: "/tmp/test.term",
    });
    expect(env).not.toHaveProperty("COCALC_API_URL");
    expect(env).not.toHaveProperty("COCALC_AGENT_TOKEN");
    expect(env).not.toHaveProperty("COCALC_BEARER_TOKEN");
  });

  it("preserves explicit env when supplied", () => {
    const env = mergeTerminalEnv0({
      env: {
        PATH: "/explicit/bin",
        COCALC_API_URL: "http://should-be-allowed-if-explicit",
      },
      env0: {
        LANG: "C.UTF-8",
      },
      baseEnv: {
        PATH: "/usr/bin",
      },
    });

    expect(env).toEqual({
      PATH: "/explicit/bin",
      COCALC_API_URL: "http://should-be-allowed-if-explicit",
      LANG: "C.UTF-8",
    });
  });

  it("forwards socket reconnection settings to the terminal socket", () => {
    const connect = jest.fn(() => ({
      on: jest.fn(),
      request: jest.fn(),
      close: jest.fn(),
    }));
    const client = {
      socket: {
        connect,
      },
    } as any;

    terminalClient({
      client,
      project_id: "project-1",
      reconnection: false,
    });

    expect(connect).toHaveBeenCalledWith("terminal.project-project-1.0", {
      reconnection: false,
    });
  });

  it("forwards socket lifecycle telemetry to the terminal socket", () => {
    const lifecycleReporter = jest.fn();
    const connect = jest.fn(() => ({
      on: jest.fn(),
      request: jest.fn(),
      close: jest.fn(),
    }));
    const client = { socket: { connect } } as any;

    terminalClient({
      client,
      project_id: "project-1",
      lifecycleReporter,
    });

    expect(connect).toHaveBeenCalledWith("terminal.project-project-1.0", {
      reconnection: undefined,
      lifecycleReporter,
    });
  });

  it("supports terminal introspection and safe input requests", async () => {
    const request = jest.fn(async (payload) => {
      if (payload.cmd === "list") {
        return { data: [{ id: "/home/user/a.term", state: "running" }] };
      }
      if (payload.cmd === "history") {
        return { data: "history" };
      }
      if (payload.cmd === "state") {
        return { data: "running" };
      }
      if (payload.cmd === "cwd") {
        return { data: "/home/user" };
      }
      if (payload.cmd === "write") {
        return { data: { written: true } };
      }
      throw new Error(`unexpected request ${payload.cmd}`);
    });
    const client = {
      socket: {
        connect: jest.fn(() => ({
          on: jest.fn(),
          request,
          close: jest.fn(),
        })),
      },
    } as any;

    const terminal = terminalClient({
      client,
      project_id: "project-1",
    });

    await expect(terminal.list()).resolves.toEqual([
      { id: "/home/user/a.term", state: "running" },
    ]);
    await expect(terminal.history("/home/user/a.term")).resolves.toBe(
      "history",
    );
    await expect(terminal.state("/home/user/a.term")).resolves.toBe("running");
    await expect(terminal.cwd("/home/user/a.term")).resolves.toBe("/home/user");
    await expect(
      terminal.write({
        id: "/home/user/a.term",
        input: "pwd\n",
      }),
    ).resolves.toEqual({ written: true });
    expect(request).toHaveBeenLastCalledWith({
      cmd: "write",
      id: "/home/user/a.term",
      input: "pwd\n",
      kind: "auto",
    });
  });
});

describe("terminalServer", () => {
  it("uses a keepalive timeout with real jitter budget", () => {
    const server = { on: jest.fn() };
    const listen = jest.fn(() => server);
    const client = {
      socket: {
        listen,
      },
    } as any;

    expect(
      terminalServer({
        client,
        project_id: "project-1",
        spawn: jest.fn(),
      } as any),
    ).toBe(server);

    expect(listen).toHaveBeenCalledWith("terminal.project-project-1.0", {
      keepAlive: 45_000,
      keepAliveTimeout: 30_000,
    });
  });

  it("forwards initial PTY output emitted during postHook", async () => {
    const server = new EventEmitter() as any;
    const client = {
      socket: {
        listen: jest.fn(() => server),
      },
    } as any;
    const pty = new EventEmitter() as any;
    pty.pid = 1234;
    pty.pause = jest.fn();
    pty.resume = jest.fn();
    pty.destroy = jest.fn();
    const socket = new EventEmitter() as any;
    socket.id = "socket-1";
    socket.subject = "terminal.project-project-1.0.server.server-1.socket-1";
    socket.write = jest.fn();
    socket.request = jest.fn(async () => ({ data: undefined }));
    socket.end = jest.fn();

    terminalServer({
      client,
      project_id: "project-1",
      spawn: jest.fn(() => pty),
      postHook: async () => {
        pty.emit("data", "prompt");
      },
    });
    server.emit("connection", socket);

    const response = await new Promise<any>((resolve) => {
      socket.emit("request", {
        data: {
          cmd: "spawn",
          command: "bash",
          options: { id: "post-hook-output", path: "a.term" },
        },
        respondSync: resolve,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(response.history).toBe("prompt");
    expect(socket.write).toHaveBeenCalledWith("prompt");

    await new Promise<void>((resolve) => {
      socket.emit("request", {
        data: { cmd: "destroy" },
        respondSync: () => resolve(),
      });
    });
    socket.emit("closed");
  });

  function fakeTerminalServer(maxSessions?: number) {
    const server = new EventEmitter() as any;
    const client = {
      socket: {
        listen: jest.fn(() => server),
      },
    } as any;
    const ptys: any[] = [];
    const spawn = jest.fn(() => {
      const pty = new EventEmitter() as any;
      pty.pid = 5000 + ptys.length;
      pty.pause = jest.fn();
      pty.resume = jest.fn();
      pty.destroy = jest.fn();
      ptys.push(pty);
      return pty;
    });
    terminalServer({ client, project_id: "project-1", spawn, maxSessions });
    let sockets = 0;
    const connect = () => {
      const socket = new EventEmitter() as any;
      socket.id = `reap-socket-${++sockets}`;
      socket.subject = `terminal.project-project-1.0.server.server-1.${socket.id}`;
      socket.write = jest.fn();
      socket.request = jest.fn(async () => ({ data: undefined }));
      socket.end = jest.fn();
      server.emit("connection", socket);
      const request = (data: any) =>
        new Promise<any>((resolve, reject) => {
          socket.emit("request", {
            data,
            respondSync: (resp, opts) =>
              opts?.headers?.error
                ? reject(new Error(opts.headers.error))
                : resolve(resp),
          });
        });
      return { socket, request };
    };
    return { ptys, connect };
  }

  it("forgets a session whose process exits after its client left", async () => {
    const { ptys, connect } = fakeTerminalServer(1);
    const cli = connect();
    await cli.request({
      cmd: "spawn",
      command: "bash",
      options: { id: "reap-cli-job" },
    });
    // the CLI disconnects right after spawning; the command ends later
    cli.socket.emit("closed");
    ptys[0].emit("data", "done\n");
    ptys[0].emit("exit");

    const other = connect();
    expect(await other.request({ cmd: "state", id: "reap-cli-job" })).toBe(
      "off",
    );
    // what it printed stays readable
    expect(await other.request({ cmd: "history", id: "reap-cli-job" })).toBe(
      "done\n",
    );
    // and it no longer counts against the session limit
    const next = await other.request({
      cmd: "spawn",
      command: "bash",
      options: { id: "reap-next-job" },
    });
    expect(next.pid).toBe(ptys[1].pid);
    // the same id starts a new process instead of reusing the dead one
    ptys[1].emit("exit");
    const again = await connect().request({
      cmd: "spawn",
      command: "bash",
      options: { id: "reap-cli-job" },
    });
    expect(again.pid).toBe(ptys[2].pid);
    ptys[2].emit("exit");
    other.socket.emit("closed");
  });

  it("frees the slot at once when a session is destroyed", async () => {
    const { ptys, connect } = fakeTerminalServer(1);
    const { socket, request } = connect();
    await request({
      cmd: "spawn",
      command: "bash",
      options: { id: "reap-destroyed" },
    });
    await request({ cmd: "destroy" });
    expect(ptys[0].destroy).toHaveBeenCalled();
    const next = await connect().request({
      cmd: "spawn",
      command: "bash",
      options: { id: "reap-after-destroy" },
    });
    expect(next.pid).toBe(ptys[1].pid);
    // a late exit of the destroyed process does not touch the new session
    ptys[0].emit("exit");
    expect(
      await connect().request({ cmd: "state", id: "reap-after-destroy" }),
    ).toBe("running");
    ptys[1].emit("exit");
    socket.emit("closed");
  });

  it("keeps the output of only the most recent ended sessions", async () => {
    const { ptys, connect } = fakeTerminalServer();
    for (let i = 0; i < 40; i++) {
      const { socket, request } = connect();
      await request({
        cmd: "spawn",
        command: "bash",
        options: { id: `reap-bulk-${i}` },
      });
      socket.emit("closed");
      ptys[i].emit("data", `out ${i}`);
      ptys[i].emit("exit");
    }
    const listed = new Set(
      (await connect().request({ cmd: "list" })).map(({ id }) => id),
    );
    for (let i = 0; i < 40; i++) {
      expect(listed.has(`reap-bulk-${i}`)).toBe(i >= 8);
    }
  });
});
