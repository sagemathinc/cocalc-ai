#!/usr/bin/env ts-node
import { buildAutomationAcpConfig } from "../automation-request-config";

describe("buildAutomationAcpConfig", () => {
  it("preserves full-access codex thread settings for automation runs", () => {
    expect(
      buildAutomationAcpConfig({
        chatPath: "/home/wstein/project/example.chat",
        config: {
          sessionId: "  thread-session-1  ",
          model: "gpt-5.3-codex-spark",
          reasoning: "low",
          workingDirectory: "/srv/work",
          envHome: "/home/wstein",
          envPath: "/usr/local/bin:/usr/bin",
          sessionMode: "full-access",
          allowWrite: false,
          codexPathOverride: "/opt/codex/bin/codex",
        },
      }),
    ).toEqual({
      sessionId: "thread-session-1",
      model: "gpt-5.3-codex-spark",
      reasoning: "low",
      workingDirectory: "/srv/work",
      sessionMode: "full-access",
      allowWrite: true,
      env: {
        HOME: "/home/wstein",
        PATH: "/usr/local/bin:/usr/bin",
      },
      codexPathOverride: "/opt/codex/bin/codex",
    });
  });

  it("defaults automation runs to the chat directory in auto mode", () => {
    expect(
      buildAutomationAcpConfig({
        chatPath: "/tmp/automation/thread.chat",
      }),
    ).toEqual({
      workingDirectory: "/tmp/automation",
      sessionMode: "auto",
      allowWrite: true,
    });
  });
});
