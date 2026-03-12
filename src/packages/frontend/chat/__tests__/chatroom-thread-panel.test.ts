import {
  DEFAULT_NEW_THREAD_SETUP,
  applyNewThreadSetupPatch,
  resolveCompactThreadBadgeAppearance,
} from "../chatroom-thread-panel";
import immutable from "immutable";
import { COLORS } from "@cocalc/util/theme";

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

describe("resolveCompactThreadBadgeAppearance", () => {
  const thread = {
    key: "thread-1",
    label: "Thread 1",
    displayLabel: "Thread 1",
    newestTime: 1000,
    messageCount: 1,
    hasCustomName: false,
    hasCustomAppearance: true,
    readCount: 0,
    unreadCount: 0,
    isAI: true,
    isPinned: false,
    isArchived: false,
    threadColor: COLORS.BLUE,
    threadIcon: "ellipsis",
  } as any;

  it("uses the codex-active color for the compact thread badge", () => {
    expect(
      resolveCompactThreadBadgeAppearance({
        thread,
        activityNow: 10_000,
        acpState: immutable
          .Map<string, string>()
          .set("thread:thread-1", "running"),
      }),
    ).toEqual({
      badgeColor: COLORS.RUN,
      badgeSize: 16,
    });
  });

  it("keeps the stored thread color when there is no active status", () => {
    expect(
      resolveCompactThreadBadgeAppearance({
        thread,
        activityNow: 10_000,
        acpState: immutable.Map<string, string>(),
      }),
    ).toEqual({
      badgeColor: COLORS.BLUE,
      badgeSize: 18,
    });
  });
});
