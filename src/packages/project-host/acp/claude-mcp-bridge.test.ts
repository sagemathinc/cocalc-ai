/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The whole path of a user's MCP server, with real processes: the
// controller's relay.cjs, the tool bridge socket and its authority check,
// the host relay and its policy, the project service, and a stdio MCP
// server. Only conat is replaced, by an in-memory socket pair.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  serveClaudeMcpSocket,
  type ClaudeMcpRuntime,
} from "@cocalc/conat/project/claude-mcp";
import { claudeMcpServers } from "@cocalc/util/ai/claude-mcp-config";
import { createClaudeProjectToolBridge } from "./claude-project-tool-bridge";

const PROJECT_ID = "00000000-0000-4000-8000-000000000002";

// A minimal MCP server: answers initialize, tools/list and tools/call, and
// asks Claude for a sampling (which the host must refuse) when told to.
const SERVER = String.raw`
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  else if (m.method === "tools/call") {
    send({ jsonrpc: "2.0", id: "s1", method: "sampling/createMessage", params: {} });
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo: " + m.params.arguments.text }] } });
  } else if (m.id === "s1") send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "sampling answered: " + JSON.stringify(m.error) } });
});
`;

let home: string;
let claudeJson: any;
const children: ChildProcess[] = [];

const runtime = (): ClaudeMcpRuntime => ({
  home,
  readJson: async (path) =>
    path === `${home}/.claude.json` ? claudeJson : undefined,
  spawn: ({ command, args, cwd, env }) => {
    const child = spawn(command, args, { cwd, env, detached: true });
    children.push(child);
    return child as any;
  },
  killGroup: (pid, signal) => {
    try {
      process.kill(-pid, signal);
    } catch {}
  },
  baseEnv: () => ({ PATH: process.env.PATH ?? "" }),
});

/** A conat socket pair, in memory. */
function socketPair() {
  const host: any = new EventEmitter();
  const service: any = new EventEmitter();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    host.emit("closed");
    service.emit("closed");
  };
  host.write = (data: any) =>
    setImmediate(() => !closed && service.emit("data", data));
  host.close = close;
  service.write = (data: any, opts?: { headers?: any }) =>
    setImmediate(() => !closed && host.emit("data", data, opts?.headers));
  service.close = close;
  return { host, service };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "claude-mcp-"));
  await writeFile(join(home, "server.js"), SERVER);
  claudeJson = {
    mcpServers: {
      echo: { command: process.execPath, args: [join(home, "server.js")] },
    },
  };
});

afterAll(() => {
  for (const child of children) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }
});

async function bridgeWith(authorize: () => Promise<void> = async () => {}) {
  let served = 0;
  const bridge = await createClaudeProjectToolBridge(
    PROJECT_ID,
    jest.fn() as any,
    authorize,
    () => {
      const { host, service } = socketPair();
      served++;
      serveClaudeMcpSocket(service, runtime(), () => () => {});
      return host;
    },
  );
  const server = claudeMcpServers({ claudeJson, cwd: home }).servers[0];
  bridge.setMcpServers(home, [server]);
  return { bridge, served: () => served };
}

/** Run relay.cjs as the controller would, talking MCP to it. */
function relayProcess(directory: string, name: string) {
  const child = spawn(process.execPath, [join(directory, "relay.cjs"), name], {
    env: { ...process.env, COCALC_PROJECT_TOOL_DIR: directory },
  });
  children.push(child);
  const lines: any[] = [];
  const waiters: (() => void)[] = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    lines.push(JSON.parse(line));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (pred: (m: any) => boolean) => {
    for (;;) {
      const found = lines.find(pred);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const send = (m: object) => child.stdin!.write(JSON.stringify(m) + "\n");
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  return { child, send, next, exited };
}

test("a user's MCP server answers Claude through the whole relay, sampling refused", async () => {
  const { bridge } = await bridgeWith();
  try {
    const relay = relayProcess(bridge.directory, "echo");
    relay.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect((await relay.next((m) => m.id === 1)).result.serverInfo.name).toBe(
      "echo",
    );
    relay.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await relay.next((m) => m.id === 2)).result.tools[0].name).toBe(
      "echo",
    );
    relay.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    expect((await relay.next((m) => m.id === 3)).result.content[0].text).toBe(
      "echo: hi",
    );
    // The server's sampling request never reached Claude; the host answered.
    const note = await relay.next((m) => m.method === "notifications/message");
    expect(note.params.data).toMatch(/-32601/);
    relay.child.stdin!.end();
    await relay.exited;
  } finally {
    await bridge.close();
  }
}, 30_000);

test("refuses a wrong token, an unlisted server and a failed authority check", async () => {
  const denied = await bridgeWith(async () => {
    throw Error("No longer authorized");
  });
  const allowed = await bridgeWith();
  try {
    const token = await readFile(
      join(allowed.bridge.directory, "token"),
      "utf8",
    );
    const attempt = (directory: string, first: object) =>
      new Promise<string>((resolve) => {
        const socket = connect(join(directory, "tool.sock"));
        let out = "";
        socket.on("connect", () => socket.write(JSON.stringify(first) + "\n"));
        socket.on("data", (d) => (out += d));
        socket.on("close", () => resolve(out));
        socket.on("error", () => resolve(out));
      });
    expect(
      await attempt(allowed.bridge.directory, { token: "wrong", mcp: "echo" }),
    ).toBe("");
    expect(
      await attempt(allowed.bridge.directory, { token, mcp: "unlisted" }),
    ).toBe("");
    const deniedToken = await readFile(
      join(denied.bridge.directory, "token"),
      "utf8",
    );
    expect(
      await attempt(denied.bridge.directory, {
        token: deniedToken,
        mcp: "echo",
      }),
    ).toBe("");
    expect(allowed.served()).toBe(0);
    expect(denied.served()).toBe(0);
  } finally {
    await denied.bridge.close();
    await allowed.bridge.close();
  }
}, 30_000);

test("closing the bridge ends open relays and their servers", async () => {
  const { bridge } = await bridgeWith();
  const relay = relayProcess(bridge.directory, "echo");
  relay.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await relay.next((m) => m.id === 1);
  const server = children[children.length - 2];
  const serverExit = new Promise((resolve) => server.once("exit", resolve));
  await bridge.close();
  await relay.exited;
  await serverExit;
}, 30_000);
