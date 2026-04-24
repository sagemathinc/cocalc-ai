import { mergeTerminalEnv0 } from "./index";
import { terminalClient } from "./index";

describe("mergeTerminalEnv0", () => {
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
