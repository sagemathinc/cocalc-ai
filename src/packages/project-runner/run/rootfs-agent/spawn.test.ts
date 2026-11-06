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
      "--env",
      "NODE_OPTIONS=",
      "--env",
      "NODE_PATH=",
      "--env",
      "NODE_EXTRA_CA_CERTS=",
      "--env",
      "LD_PRELOAD=",
      "--env",
      "LD_LIBRARY_PATH=",
      "--env",
      "LD_AUDIT=",
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

  it("refuses NODE_OPTIONS, NODE_PATH or any other node variable in the environment (E2)", () => {
    for (const entry of [
      "NODE_OPTIONS=--require=/home/user/x.js",
      "NODE_PATH=/home/user",
      "NODE_EXTRA_CA_CERTS=/x",
      "LD_PRELOAD=/home/user/x.so",
    ]) {
      const args = good();
      const at = args.indexOf("--env");
      args.splice(at, 0, "--env", entry);
      expect(() => checkAgentExecArgs(args, opts)).toThrow(
        "refusing to start the rootfs agent",
      );
    }
  });

  it("blanks every node and loader variable the container's own environment might set (B2)", () => {
    for (const key of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "NODE_EXTRA_CA_CERTS",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "LD_AUDIT",
    ]) {
      const args = good();
      // dropping the blank, or giving it a value, is refused
      const at = args.indexOf(`${key}=`);
      expect(at).toBeGreaterThan(0);
      const dropped = [...args.slice(0, at - 1), ...args.slice(at + 1)];
      expect(() => checkAgentExecArgs(dropped, opts)).toThrow(
        "refusing to start the rootfs agent",
      );
      const valued = args.map((x) => (x === `${key}=` ? `${key}=/x` : x));
      expect(() => checkAgentExecArgs(valued, opts)).toThrow(
        "refusing to start the rootfs agent",
      );
    }
  });

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
