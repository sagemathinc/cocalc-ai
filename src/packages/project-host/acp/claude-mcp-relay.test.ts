import { EventEmitter } from "node:events";
import {
  listProjectClaudeMcpServers,
  MAX_CLAUDE_MCP_QUEUED_BYTES,
  relayClaudeMcp,
} from "./claude-mcp-relay";

class FakeProject extends EventEmitter {
  subject?: string;
  written: string[] = [];
  closed = false;
  write = (data: string) => {
    this.written.push(String(data));
  };
  close = () => {
    this.closed = true;
  };
}

class FakeController extends EventEmitter {
  written: string[] = [];
  writableLength = 0;
  ended = false;
  write = (data: string) => {
    this.written.push(data);
    return true;
  };
  end = () => {
    this.ended = true;
  };
  destroy = () => {};
  paused = false;
  pause = () => {
    this.paused = true;
  };
  resume = () => {
    this.paused = false;
  };
}

const server = { name: "files", scope: "user", digest: "d".repeat(64) };
const projectId = "11111111-1111-4111-8111-111111111111";

function start(leftover = "") {
  const project = new FakeProject();
  const controller = new FakeController();
  const ends: string[] = [];
  const close = relayClaudeMcp({
    controller: controller as any,
    leftover,
    connect: (subject) => {
      project.subject = subject;
      return project as any;
    },
    projectId,
    server,
    cwd: "/home/user",
    onEnd: (why) => ends.push(why),
  });
  return { project, controller, ends, close };
}

const line = (message: object) => JSON.stringify(message);

describe("relayClaudeMcp", () => {
  it("names the server by digest and holds Claude's messages until it is ready", () => {
    const { project, controller } = start(
      line({ id: 1, method: "initialize" }) + "\n",
    );
    expect(project.subject).toBe(`claude-mcp.project-${projectId}.0`);
    expect(JSON.parse(project.written[0])).toEqual({
      ...server,
      cwd: "/home/user",
    });
    expect(project.written).toHaveLength(1);
    project.emit("data", "", { ready: true });
    expect(project.written[1]).toBe(
      line({ id: 1, method: "initialize" }) + "\n",
    );
    controller.emit("data", line({ id: 2, method: "tools/list" }) + "\n");
    expect(project.written[2]).toContain("tools/list");
  });

  it("forwards the server's responses, and answers its sampling requests itself", () => {
    const { project, controller } = start();
    project.emit("data", "", { ready: true });
    project.emit(
      "data",
      Buffer.from(
        line({ jsonrpc: "2.0", id: 1, result: { tools: [] } }) +
          "\n" +
          line({
            jsonrpc: "2.0",
            id: 9,
            method: "sampling/createMessage",
            params: {},
          }) +
          "\nnot json\n",
      ),
    );
    expect(controller.written).toEqual([
      line({ jsonrpc: "2.0", id: 1, result: { tools: [] } }) + "\n",
    ]);
    const answer = JSON.parse(project.written[project.written.length - 1]);
    expect(answer).toMatchObject({ id: 9, error: { code: -32601 } });
  });

  it("joins a character split across chunks", () => {
    const { project, controller } = start();
    project.emit("data", "", { ready: true });
    const bytes = Buffer.from(line({ id: 1, result: { text: "€" } }) + "\n");
    const cut = bytes.indexOf(Buffer.from("€")) + 1;
    project.emit("data", bytes.subarray(0, cut));
    project.emit("data", bytes.subarray(cut));
    expect(JSON.parse(controller.written[0]).result.text).toBe("€");
  });

  it("ends when the project refuses, the server exits, or Claude closes", () => {
    for (const trigger of [
      (r: any) =>
        r.project.emit("data", "", {
          error: "changed since the session started",
        }),
      (r: any) => r.project.emit("data", "", { exit: 1, stderr: "x" }),
      (r: any) => r.controller.emit("close"),
      (r: any) => r.project.emit("closed"),
      (r: any) => r.close(),
    ]) {
      const r = start();
      trigger(r);
      expect(r.ends).toHaveLength(1);
      expect(r.project.closed).toBe(true);
      expect(r.controller.ended).toBe(true);
    }
  });

  it("gives up on a controller that isn't reading", () => {
    const { project, controller, ends } = start();
    project.emit("data", "", { ready: true });
    controller.writableLength = MAX_CLAUDE_MCP_QUEUED_BYTES + 1;
    project.emit("data", line({ id: 1, result: {} }) + "\n");
    expect(ends).toEqual(["Claude is not reading the MCP server's output"]);
  });

  it("pauses Claude while the project is behind, and resumes on drain", () => {
    const { project, controller } = start();
    project.emit("data", "", { ready: true });
    const big = "x".repeat(1_000_000);
    for (let i = 0; i < 5; i++) controller.emit("data", big + "\n");
    expect(controller.paused).toBe(true);
    project.emit("drain");
    expect(controller.paused).toBe(false);
  });

  it("bounds what is held before the server is ready, in bytes", () => {
    const { controller, ends } = start();
    const big = "x".repeat(1_000_000);
    for (let i = 0; i < 5; i++) controller.emit("data", big + "\n");
    expect(ends).toEqual(["too much sent before the server was ready"]);
  });

  it("ends on an oversized message either way", () => {
    const a = start();
    a.project.emit("data", "", { ready: true });
    a.project.emit("data", "x".repeat(1_300_000));
    expect(a.ends[0]).toMatch(/too large/);
    const b = start();
    b.controller.emit("data", "y".repeat(1_300_000));
    expect(b.ends[0]).toMatch(/too large/);
  });
});

describe("listProjectClaudeMcpServers", () => {
  it("asks the project for its list", async () => {
    const project = new FakeProject();
    const list = { servers: [server], skipped: [] };
    const promise = listProjectClaudeMcpServers(
      () => project as any,
      projectId,
      "/home/user",
    );
    expect(JSON.parse(project.written[0])).toEqual({
      list: true,
      cwd: "/home/user",
    });
    project.emit("data", "", { list });
    await expect(promise).resolves.toEqual(list);
    expect(project.closed).toBe(true);
  });

  it("fails if the project doesn't answer", async () => {
    const project = new FakeProject();
    await expect(
      listProjectClaudeMcpServers(() => project as any, projectId, "/h", 10),
    ).rejects.toThrow(/did not list/);
  });
});
