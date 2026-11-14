import { cleanup } from "@cocalc/project/project-setup";
import {
  captureEnv,
  PRESERVED_COCALC_ENV_KEYS,
  restoreEnv,
} from "../../../preserved-env";

describe("Lite startup environment", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("keeps the Claude Code overrides through cleanup, as main() does", () => {
    process.env.COCALC_CLAUDE_BIN = "/opt/claude/bin/claude";
    process.env.COCALC_CLAUDE_AGENT_ACP = "/opt/adapter/dist/index.js";
    process.env.COCALC_SOMETHING_ELSE = "dropped";
    const preserved = captureEnv(PRESERVED_COCALC_ENV_KEYS);
    cleanup();
    expect(process.env.COCALC_CLAUDE_BIN).toBeUndefined();
    restoreEnv(preserved);
    expect(process.env.COCALC_CLAUDE_BIN).toBe("/opt/claude/bin/claude");
    expect(process.env.COCALC_CLAUDE_AGENT_ACP).toBe(
      "/opt/adapter/dist/index.js",
    );
    expect(process.env.COCALC_SOMETHING_ELSE).toBeUndefined();
  });
});
