import {
  DEFAULT_NEW_THREAD_SETUP,
  applyNewThreadSetupPatch,
} from "../chatroom-thread-panel";

describe("new thread setup patching", () => {
  it("preserves a chosen codex model when a later patch changes execution mode", () => {
    const withModel = applyNewThreadSetupPatch(DEFAULT_NEW_THREAD_SETUP, {
      model: "gpt-5.4",
      codexConfig: {
        ...DEFAULT_NEW_THREAD_SETUP.codexConfig,
        model: "gpt-5.4",
      },
    });

    const withSessionMode = applyNewThreadSetupPatch(withModel, {
      codexConfig: {
        ...withModel.codexConfig,
        sessionMode: "workspace-write",
      },
    });

    expect(withSessionMode.model).toBe("gpt-5.4");
    expect(withSessionMode.codexConfig.model).toBe("gpt-5.4");
    expect(withSessionMode.codexConfig.sessionMode).toBe("workspace-write");
  });
});
