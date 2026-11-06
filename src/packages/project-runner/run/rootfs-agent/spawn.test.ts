import {
  agentExecArgs,
  AGENT_SECURITY_OPT,
  checkAgentExecArgs,
  type AgentExecOptions,
} from "./spawn";

const opts: AgentExecOptions = {
  containerId: "a".repeat(64),
  nodePath: "/opt/cocalc/bin/node",
  agentCode: "/* agent */",
  token: "0123456789abcdef0123456789abcdef",
  toolsPath: "/opt/cocalc/bin2",
};

describe("rootfs agent spawn args", () => {
  it("are exactly: exec -i as the project user, no new privileges, the allowlisted env, the container id, host code", () => {
    expect(agentExecArgs(opts)).toEqual([
      "exec",
      "-i",
      "--user",
      "2001:2001",
      "--security-opt=no-new-privileges",
      "--workdir",
      "/home/user",
      "--env",
      "HOME=/home/user",
      "--env",
      "USER=user",
      "--env",
      "LOGNAME=user",
      "--env",
      "PATH=/opt/cocalc/bin2",
      "--env",
      "LANG=C.UTF-8",
      "a".repeat(64),
      "/opt/cocalc/bin/node",
      "-e",
      "/* agent */",
      "--",
      opts.token,
    ]);
  });

  const good = () => agentExecArgs(opts);
  const mutations: [string, (args: string[]) => string[]][] = [
    ["a tty", (a) => [a[0], "-t", ...a.slice(1)]],
    ["-it", (a) => [a[0], "-it", ...a.slice(2)]],
    ["--privileged", (a) => [...a.slice(0, 5), "--privileged", ...a.slice(5)]],
    [
      "--cap-add",
      (a) => [...a.slice(0, 5), "--cap-add", "SYS_ADMIN", ...a.slice(5)],
    ],
    [
      "another security option",
      (a) => [...a.slice(0, 5), "--security-opt=label=disable", ...a.slice(5)],
    ],
    [
      "no-new-privileges dropped",
      (a) => a.filter((x) => x !== AGENT_SECURITY_OPT),
    ],
    ["root", (a) => a.map((x) => (x === "2001:2001" ? "0" : x))],
    ["another user", (a) => a.map((x) => (x === "2001:2001" ? "0:0" : x))],
    ["-u", (a) => a.map((x) => (x === "--user" ? "-u" : x))],
    [
      "an inherited environment",
      (a) => [...a.slice(0, 7), "--env-host", ...a.slice(7)],
    ],
    [
      "an env file",
      (a) => [...a.slice(0, 7), "--env-file", "/tmp/e", ...a.slice(7)],
    ],
    [
      "an extra env entry",
      (a) => [
        ...a.slice(0, 7),
        "--env",
        "NODE_OPTIONS=--require=/x",
        ...a.slice(7),
      ],
    ],
    [
      "-e for env",
      (a) => [...a.slice(0, 7), "-e", "LD_PRELOAD=/x", ...a.slice(7)],
    ],
    [
      "a changed env value",
      (a) =>
        a.map((x) => (x === "PATH=/opt/cocalc/bin2" ? "PATH=/usr/bin" : x)),
    ],
    [
      "the container name",
      (a) => a.map((x) => (x === "a".repeat(64) ? "project-x" : x)),
    ],
    [
      "code from the rootfs",
      (a) => a.map((x) => (x === "-e" ? "/home/user/agent.js" : x)),
    ],
    [
      "another interpreter",
      (a) => a.map((x) => (x === "/opt/cocalc/bin/node" ? "/usr/bin/node" : x)),
    ],
    ["another workdir", (a) => a.map((x) => (x === "/home/user" ? "/" : x))],
    ["trailing arguments", (a) => [...a, "--extra"]],
    ["exec without -i", (a) => a.filter((x) => x !== "-i")],
  ];

  for (const [name, mutate] of mutations) {
    it(`refuses ${name}`, () => {
      expect(() => checkAgentExecArgs(mutate(good()), opts)).toThrow(
        "refusing to start the rootfs agent",
      );
    });
  }

  it("refuses a container name, a bad token or a relative node path", () => {
    for (const bad of [
      { containerId: "project-1" },
      { containerId: "A".repeat(64) },
      { token: "x" },
      { nodePath: "node" },
      { nodePath: "/opt/node;rm" },
    ]) {
      expect(() => agentExecArgs({ ...opts, ...bad })).toThrow(
        "refusing to start the rootfs agent",
      );
    }
  });
});
