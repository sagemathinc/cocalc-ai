import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  MAX_CLAUDE_MCP_QUEUED_BYTES,
  claudeMcpBaseEnv,
  resolveClaudeMcpServer,
  serveClaudeMcpSocket,
  type ClaudeMcpRuntime,
} from "./claude-mcp";
import { claudeMcpServers } from "@cocalc/util/ai/claude-mcp-config";

const home = "/home/user";
const cwd = "/home/user/work";
const claudeJson = {
  mcpServers: {
    echo: { command: "node", args: ["${HOME}/echo.js"], env: { A: "1" } },
  },
};
const server = claudeMcpServers({ claudeJson, cwd }).servers[0];
const setup = { name: "echo", scope: "user", digest: server.digest, cwd };

class FakeSocket extends EventEmitter {
  written: { data: any; headers?: any }[] = [];
  closed = false;
  write = (data: any, opts?: { headers?: any }) => {
    this.written.push({ data, headers: opts?.headers });
  };
  close = () => {
    this.closed = true;
  };
}

function runtime(files: Record<string, unknown> = {}) {
  const spawned: any[] = [];
  const kills: [number, string][] = [];
  const children: any[] = [];
  const rt: ClaudeMcpRuntime = {
    home,
    readJson: async (path) =>
      path in files
        ? files[path]
        : path === `${home}/.claude.json`
          ? claudeJson
          : undefined,
    spawn: (opts) => {
      spawned.push(opts);
      const child: any = new EventEmitter();
      child.pid = 4242;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      children.push(child);
      return child;
    },
    killGroup: (pid, signal) => kills.push([pid, signal]),
    baseEnv: () => ({ HOME: home, PATH: "/usr/bin" }),
  };
  return { rt, spawned, kills, children };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("claude mcp project service", () => {
  it("starts the configured server and relays its stdio both ways", async () => {
    const { rt, spawned, kills, children } = runtime();
    const socket = new FakeSocket();
    let admitted = 0;
    let released = 0;
    serveClaudeMcpSocket(socket as any, rt, () => {
      admitted++;
      return () => released++;
    });
    socket.emit("data", JSON.stringify(setup));
    await settle();
    expect(spawned).toEqual([
      {
        command: "node",
        args: ["/home/user/echo.js"],
        cwd,
        env: { HOME: home, PATH: "/usr/bin", A: "1" },
      },
    ]);
    expect(socket.written[0].headers).toEqual({ ready: true });
    // agent -> server
    const input: string[] = [];
    children[0].stdin.on("data", (d: Buffer) => input.push(d.toString()));
    socket.emit("data", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await settle();
    expect(input.join("")).toContain("tools/list");
    // server -> agent
    children[0].stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await settle();
    expect(Buffer.from(socket.written[1].data).toString()).toContain(
      '"result"',
    );
    // the agent side closes: the whole process group is stopped, and the
    // slot is held until it has exited
    socket.emit("closed");
    expect(kills).toEqual([[4242, "SIGTERM"]]);
    expect([admitted, released]).toEqual([1, 0]);
    children[0].emit("exit", null);
    expect([admitted, released]).toEqual([1, 1]);
    // what remains of its group goes at once; no delayed kill afterwards
    expect(kills).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
  });

  it("never kills a group after its leader exited", async () => {
    jest.useFakeTimers();
    try {
      const { rt, kills, children } = runtime();
      const socket = new FakeSocket();
      serveClaudeMcpSocket(socket as any, rt, () => () => {});
      socket.emit("data", JSON.stringify(setup));
      for (let i = 0; i < 5; i++) await Promise.resolve();
      socket.emit("closed");
      children[0].emit("exit", 0);
      const before = kills.length;
      jest.advanceTimersByTime(60_000);
      expect(kills.length).toBe(before);
    } finally {
      jest.useRealTimers();
    }
  });

  it("pauses the server's output while the agent is behind, and resumes on drain", async () => {
    const { rt, children } = runtime();
    const socket = new FakeSocket();
    serveClaudeMcpSocket(socket as any, rt, () => () => {});
    socket.emit("data", JSON.stringify(setup));
    await settle();
    const stdout = children[0].stdout;
    stdout.write(Buffer.alloc(MAX_CLAUDE_MCP_QUEUED_BYTES + 1));
    await settle();
    expect(stdout.isPaused()).toBe(true);
    socket.emit("drain");
    expect(stdout.isPaused()).toBe(false);
  });

  it("ends when the server stops reading its input", async () => {
    const { rt, children } = runtime();
    const socket = new FakeSocket();
    serveClaudeMcpSocket(socket as any, rt, () => () => {});
    socket.emit("data", JSON.stringify(setup));
    await settle();
    Object.defineProperty(children[0].stdin, "writableLength", {
      value: MAX_CLAUDE_MCP_QUEUED_BYTES + 1,
    });
    socket.emit("data", "{}\n");
    expect(socket.closed).toBe(true);
  });

  it("refuses a server whose definition changed since the session started", async () => {
    const { rt, spawned } = runtime({
      [`${home}/.claude.json`]: {
        mcpServers: { echo: { command: "evil", args: [] } },
      },
    });
    const socket = new FakeSocket();
    serveClaudeMcpSocket(socket as any, rt, () => () => {});
    socket.emit("data", JSON.stringify(setup));
    await settle();
    expect(spawned).toEqual([]);
    expect(socket.written[0].headers.error).toMatch(
      /changed since the session/,
    );
    expect(socket.closed).toBe(true);
  });

  it("refuses beyond the project's process limit", async () => {
    const { rt, spawned } = runtime();
    const socket = new FakeSocket();
    serveClaudeMcpSocket(socket as any, rt, () => undefined);
    socket.emit("data", JSON.stringify(setup));
    await settle();
    expect(spawned).toEqual([]);
    expect(socket.written[0].headers.error).toMatch(/at most/);
  });

  it("reports the exit with the end of stderr, and closes", async () => {
    const { rt, children } = runtime();
    const socket = new FakeSocket();
    serveClaudeMcpSocket(socket as any, rt, () => () => {});
    socket.emit("data", JSON.stringify(setup));
    await settle();
    children[0].stderr.write("boom: missing module\n");
    await settle();
    children[0].emit("exit", 1);
    const last = socket.written[socket.written.length - 1];
    expect(last.headers).toEqual({ exit: 1, stderr: "boom: missing module\n" });
    expect(socket.closed).toBe(true);
  });

  it("a broken pipe to a dead server ends the relay instead of throwing", async () => {
    const { rt, children, kills } = runtime();
    const socket = new FakeSocket();
    serveClaudeMcpSocket(socket as any, rt, () => () => {});
    socket.emit("data", JSON.stringify(setup));
    await settle();
    children[0].stdin.emit(
      "error",
      Object.assign(new Error("EPIPE"), { code: "EPIPE" }),
    );
    expect(socket.closed).toBe(true);
    expect(kills[0]).toEqual([4242, "SIGTERM"]);
  });

  it("closes an idle relay", async () => {
    jest.useFakeTimers();
    try {
      const { rt, kills } = runtime();
      const socket = new FakeSocket();
      serveClaudeMcpSocket(socket as any, rt, () => () => {}, 1000);
      socket.emit("data", JSON.stringify(setup));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(1500);
      expect(socket.closed).toBe(true);
      expect(kills[0]).toEqual([4242, "SIGTERM"]);
      jest.advanceTimersByTime(6000);
      expect(kills[1]).toEqual([4242, "SIGKILL"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("lists the configured servers without starting any", async () => {
    const { rt, spawned } = runtime({
      [`${cwd}/.mcp.json`]: { mcpServers: { repo: { command: "x" } } },
    });
    const socket = new FakeSocket();
    serveClaudeMcpSocket(socket as any, rt, () => () => {});
    socket.emit("data", JSON.stringify({ list: true, cwd }));
    await settle();
    expect(spawned).toEqual([]);
    expect(socket.written[0].headers.list).toEqual({
      servers: [{ name: "echo", scope: "user", digest: server.digest }],
      skipped: [
        {
          name: "repo",
          scope: "project",
          reason: expect.stringMatching(/not approved/),
        },
      ],
    });
    expect(socket.closed).toBe(true);
  });

  it("resolves only well-formed setups", async () => {
    const { rt } = runtime();
    expect(
      await resolveClaudeMcpServer(rt, { ...setup, cwd: "relative" }),
    ).toEqual({ error: "invalid MCP setup" });
    expect(
      await resolveClaudeMcpServer(rt, { ...setup, name: "other" }),
    ).toEqual({ error: "MCP server other is no longer configured" });
  });
});

describe("claudeMcpBaseEnv", () => {
  it("drops CoCalc's own variables", () => {
    expect(
      claudeMcpBaseEnv({
        HOME: "/home/user",
        COCALC_SECRET_TOKEN: "x",
        DEBUG: "*",
        NODE_ENV: "production",
      }),
    ).toEqual({ HOME: "/home/user" });
  });
});
