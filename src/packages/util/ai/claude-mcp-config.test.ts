import {
  claudeMcpDigest,
  claudeMcpServers,
  expandClaudeMcpVariables,
  MAX_CLAUDE_MCP_SERVERS,
} from "./claude-mcp-config";

const cwd = "/home/user/work";
const stdio = (command: string, extra: object = {}) => ({
  command,
  ...extra,
});

describe("claudeMcpServers", () => {
  it("reads user and local scope, a narrower scope winning a name", () => {
    const { servers, skipped } = claudeMcpServers({
      cwd,
      claudeJson: {
        mcpServers: {
          files: stdio("npx", { args: ["-y", "files-mcp"] }),
          shared: stdio("user-version"),
        },
        projects: {
          [cwd]: { mcpServers: { shared: stdio("local-version") } },
          "/elsewhere": { mcpServers: { other: stdio("x") } },
        },
      },
    });
    expect(skipped).toEqual([]);
    expect(servers.map((s) => [s.name, s.scope, s.command])).toEqual([
      ["shared", "local", "local-version"],
      ["files", "user", "npx"],
    ]);
    expect(servers[1].args).toEqual(["-y", "files-mcp"]);
  });

  it("uses .mcp.json servers only when the user's own files approve them", () => {
    const mcpJson = {
      mcpServers: { a: stdio("a"), b: stdio("b"), c: stdio("c") },
    };
    const none = claudeMcpServers({ cwd, mcpJson });
    expect(none.servers).toEqual([]);
    expect(none.skipped.map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(none.skipped[0].reason).toMatch(/not approved/);

    const some = claudeMcpServers({
      cwd,
      mcpJson,
      claudeJson: {
        projects: {
          [cwd]: {
            enabledMcpjsonServers: ["a"],
            disabledMcpjsonServers: ["c"],
          },
        },
      },
      userSettings: { enabledMcpjsonServers: ["b", "c"] },
    });
    expect(some.servers.map((s) => [s.name, s.scope])).toEqual([
      ["a", "project"],
      ["b", "project"],
    ]);
    expect(some.skipped).toEqual([
      { name: "c", scope: "project", reason: "disabled for this directory" },
    ]);

    const all = claudeMcpServers({
      cwd,
      mcpJson,
      userSettings: { enableAllProjectMcpServers: true },
    });
    expect(all.servers).toHaveLength(3);
  });

  it("never lets the directory approve its own servers", () => {
    // Approval keys inside .mcp.json itself mean nothing.
    const { servers } = claudeMcpServers({
      cwd,
      mcpJson: {
        enableAllProjectMcpServers: true,
        enabledMcpjsonServers: ["x"],
        mcpServers: { x: stdio("x") },
      },
    });
    expect(servers).toEqual([]);
  });

  it("skips what it can't use, with a reason", () => {
    const { servers, skipped } = claudeMcpServers({
      cwd,
      claudeJson: {
        mcpServers: {
          "bad name": stdio("x"),
          cocalc_project: stdio("x"),
          remote: { type: "http", url: "https://example.com/mcp" },
          nocommand: {},
          badargs: stdio("x", { args: [1] }),
          badenv: stdio("x", { env: { "1X": "y" } }),
          ok: stdio("node", { args: ["s.js"], env: { TOKEN: "t" } }),
        },
      },
    });
    expect(servers.map((s) => s.name)).toEqual(["ok"]);
    expect(Object.fromEntries(skipped.map((s) => [s.name, s.reason]))).toEqual({
      "bad name": "invalid name",
      cocalc_project: "names starting with cocalc are reserved",
      remote: "remote (http/sse) servers are not supported yet",
      nocommand: "missing or invalid command",
      badargs: "invalid args",
      badenv: "invalid env",
    });
  });

  it("bounds the number of servers", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_CLAUDE_MCP_SERVERS + 2 }, (_, i) => [
        `s${i}`,
        stdio("x"),
      ]),
    );
    const { servers, skipped } = claudeMcpServers({
      cwd,
      claudeJson: { mcpServers: many },
    });
    expect(servers).toHaveLength(MAX_CLAUDE_MCP_SERVERS);
    expect(skipped).toHaveLength(2);
  });

  it("binds each server to a digest of its scope and definition", () => {
    const read = (command: string, scope: "user" | "local" = "user") =>
      claudeMcpServers({
        cwd,
        claudeJson:
          scope === "user"
            ? { mcpServers: { s: stdio(command, { env: { B: "2", A: "1" } }) } }
            : {
                projects: {
                  [cwd]: {
                    mcpServers: {
                      s: stdio(command, { env: { A: "1", B: "2" } }),
                    },
                  },
                },
              },
      }).servers[0];
    const a = read("node");
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    const { digest: _digest, ...rest } = a;
    expect(claudeMcpDigest(rest)).toBe(a.digest);
    // env order doesn't matter; command and scope do
    expect(read("node", "local").digest).not.toBe(a.digest);
    expect(read("python").digest).not.toBe(a.digest);
    expect(read("node").digest).toBe(a.digest);
  });

  it("tolerates missing or malformed files", () => {
    expect(
      claudeMcpServers({ cwd, claudeJson: "x", mcpJson: [], userSettings: 3 }),
    ).toEqual({ servers: [], skipped: [] });
  });
});

describe("expandClaudeMcpVariables", () => {
  it("expands ${VAR} and ${VAR:-default}", () => {
    expect(
      expandClaudeMcpVariables("${HOME}/x ${MISSING:-def} ${NONE}", {
        HOME: "/home/user",
      }),
    ).toBe("/home/user/x def ");
  });
});
