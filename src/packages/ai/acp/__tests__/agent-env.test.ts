import { agentBaseEnv, standaloneAppServerEnv } from "../agent-env";

const user = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/data/home",
  USER: "u",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
  TERM: "xterm",
  HTTPS_PROXY: "http://proxy:3128",
  OPENAI_API_KEY: "the user's own key",
  CODEX_HOME: "/data/home/.codex",
};

const internal = {
  CONAT_SERVER: "http://localhost:30000",
  COCALC_LITE_ACP_WORKER_CONAT_PASSWORD: "internal",
  COCALC_AGENT_TOKEN: "internal",
  COCALC_API_URL: "http://inherited",
  COCALC_SOME_FUTURE_SECRET: "internal",
  MASTER_CONAT_SERVER: "http://localhost:30000",
  SMC_SOMETHING: "internal",
  DATA: "/data",
  DEBUG: "cocalc:*",
  NODE_OPTIONS: "--require /x",
};

describe("agentBaseEnv", () => {
  it("keeps the user's environment and drops internal keys", () => {
    const env = agentBaseEnv({
      ...user,
      ...internal,
      COCALC_CLI_BIN: "/opt/cocalc/bin/cocalc",
    });
    for (const key of Object.keys(internal)) {
      expect(env[key]).toBeUndefined();
    }
    expect(Object.values(env)).not.toContain("internal");
    expect(env).toMatchObject(user);
    expect(Object.keys(env).filter((k) => k.startsWith("COCALC_"))).toEqual([
      "COCALC_CLI_BIN",
    ]);
  });
});

describe("standaloneAppServerEnv", () => {
  it("starts from the sanitized environment; the caller's env and HOME win", () => {
    const env = standaloneAppServerEnv(
      {
        COCALC_API_URL: "http://localhost:9100",
        COCALC_AGENT_TOKEN: "scoped-token",
        COCALC_BEARER_TOKEN: "scoped-token",
      },
      { ...user, ...internal, COCALC_ORIGINAL_HOME: "/home/u" },
    );
    expect(env).toMatchObject({
      PATH: user.PATH,
      CODEX_HOME: user.CODEX_HOME,
      HOME: "/home/u",
      COCALC_API_URL: "http://localhost:9100",
      COCALC_AGENT_TOKEN: "scoped-token",
      COCALC_BEARER_TOKEN: "scoped-token",
    });
    for (const key of [
      "CONAT_SERVER",
      "COCALC_LITE_ACP_WORKER_CONAT_PASSWORD",
      "COCALC_SOME_FUTURE_SECRET",
      "MASTER_CONAT_SERVER",
      "SMC_SOMETHING",
      "DATA",
      "NODE_OPTIONS",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(Object.values(env)).not.toContain("internal");
    expect(Object.values(env)).not.toContain("http://inherited");
  });

  it("without a caller env, no CoCalc credentials", () => {
    const env = standaloneAppServerEnv(undefined, { ...user, ...internal });
    expect(Object.keys(env).filter((k) => k.startsWith("COCALC_"))).toEqual([]);
    expect(env.HOME).toBe(user.HOME);
  });
});
