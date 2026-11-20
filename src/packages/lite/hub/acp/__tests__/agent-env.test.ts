import { agentBaseEnv, codexAppServerEnv } from "../agent-env";

const user = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/data/home",
  USER: "u",
  SHELL: "/bin/zsh",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  HTTPS_PROXY: "http://proxy:3128",
};

const internal = {
  CONAT_SERVER: "http://localhost:30000",
  COCALC_LITE_ACP_WORKER_CONAT_PASSWORD: "internal",
  COCALC_LITE_ACP_WORKER: "1",
  COCALC_AGENT_TOKEN: "internal",
  COCALC_BEARER_TOKEN: "internal",
  COCALC_API_URL: "http://inherited",
  COCALC_SOME_FUTURE_SECRET: "internal",
  MASTER_CONAT_SERVER: "http://localhost:30000",
  DATA: "/data",
  DEBUG_FILE: "/data/log",
};

describe("agentBaseEnv", () => {
  it("keeps the user's environment and drops CoCalc's internal keys", () => {
    const env = agentBaseEnv({
      ...user,
      ...internal,
      COCALC_ORIGINAL_HOME: "/home/u",
      COCALC_CLI_BIN: "/opt/cocalc/bin/cocalc",
    });
    for (const key of Object.keys(internal)) {
      expect(env[key]).toBeUndefined();
    }
    expect(Object.values(env)).not.toContain("internal");
    expect(env).toMatchObject({ ...user, HOME: "/home/u" });
    expect(Object.keys(env).filter((key) => key.startsWith("COCALC_"))).toEqual(
      ["COCALC_CLI_BIN"],
    );
  });
});

describe("codexAppServerEnv", () => {
  it("passes the turn's explicit runtime environment, not the inherited one", () => {
    const env = codexAppServerEnv({
      base: {
        ...user,
        ...internal,
        OPENAI_API_KEY: "inherited",
        COCALC_ORIGINAL_HOME: "/home/u",
      },
      // What buildCodexRuntimeEnv provides for a turn.
      extra: {
        COCALC_API_URL: "http://localhost:9100",
        COCALC_AGENT_TOKEN: "scoped-token",
        COCALC_BEARER_TOKEN: "scoped-token",
        COCALC_PROJECT_ID: "p",
        COCALC_CLI_AGENT_MODE: "1",
      },
      codexHome: "/home/u/.codex",
    });
    expect(env).toMatchObject({
      ...user,
      HOME: "/home/u",
      CODEX_HOME: "/home/u/.codex",
      COCALC_CODEX_HOME: "/home/u/.codex",
      COCALC_API_URL: "http://localhost:9100",
      COCALC_AGENT_TOKEN: "scoped-token",
      COCALC_BEARER_TOKEN: "scoped-token",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    for (const key of [
      "CONAT_SERVER",
      "COCALC_LITE_ACP_WORKER_CONAT_PASSWORD",
      "COCALC_LITE_ACP_WORKER",
      "COCALC_SOME_FUTURE_SECRET",
      "MASTER_CONAT_SERVER",
      "DATA",
      "DEBUG_FILE",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(Object.values(env)).not.toContain("internal");
    expect(Object.values(env)).not.toContain("http://inherited");
  });

  it("without a turn environment (e.g. an account check), no CoCalc credentials", () => {
    const env = codexAppServerEnv({
      base: { ...user, ...internal },
      codexHome: "/c",
    });
    expect(
      Object.keys(env)
        .filter((key) => key.startsWith("COCALC_"))
        .sort(),
    ).toEqual(["COCALC_CODEX_HOME"]);
    expect(env.CONAT_SERVER).toBeUndefined();
  });
});
