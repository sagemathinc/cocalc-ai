/** @jest-environment jsdom */
import { ChatActions } from "../actions";
import { qualifiedHarnessRuntime } from "../harness-profile";

test("directory edits preserve native context and harness settings and update shared directory metadata", () => {
  const actions = new ChatActions("chat", {
    getStore: () => null,
    _set_state: () => undefined,
    removeActions: () => undefined,
  } as any);
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user", {
    configOptions: [{ id: "model", value: "opus" }],
  });
  const metadata = {
    agent_runtime: runtime,
    acp_config: {
      sessionId: "native-session",
      model: "acp:claude-code",
      workingDirectory: "/home/user",
    },
  };
  jest.spyOn(actions, "getThreadMetadata").mockReturnValue(metadata as any);
  const write = jest
    .spyOn(actions as any, "setThreadConfigRecord")
    .mockReturnValue(true);
  const save = jest
    .spyOn(actions as any, "saveSyncdb")
    .mockResolvedValue(undefined);
  (actions as any).syncdb = { commit: jest.fn() };
  actions.setHarnessWorkingDirectory("thread", "/home/user/work");
  expect(write).toHaveBeenCalledWith("thread", {
    agent_runtime: {
      ...runtime,
      profile: { ...runtime.profile, cwd: "/home/user/work" },
    },
    acp_config: { ...metadata.acp_config, workingDirectory: "/home/user/work" },
  });
  expect(runtime.profile.cwd).toBe("/home/user");
  expect(save).toHaveBeenCalledTimes(1);
  expect(() =>
    actions.setHarnessWorkingDirectory("thread", "relative"),
  ).toThrow();
  expect(write).toHaveBeenCalledTimes(1);
});
