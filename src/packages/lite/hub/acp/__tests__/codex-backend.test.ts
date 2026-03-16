import { getConfiguredCodexBackend } from "../codex-backend";

describe("getConfiguredCodexBackend", () => {
  it("defaults to app-server when unset", () => {
    expect(getConfiguredCodexBackend({} as NodeJS.ProcessEnv)).toBe(
      "app-server",
    );
  });

  it("honors explicit app-server override", () => {
    expect(
      getConfiguredCodexBackend({
        COCALC_ACP_CODEX_BACKEND: "app-server",
      } as NodeJS.ProcessEnv),
    ).toBe("app-server");
  });

  it("honors explicit exec override", () => {
    expect(
      getConfiguredCodexBackend({
        COCALC_ACP_CODEX_BACKEND: "exec",
      } as NodeJS.ProcessEnv),
    ).toBe("exec");
  });
});
