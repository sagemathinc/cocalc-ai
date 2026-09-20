import {
  DEFAULT_NEW_THREAD_SETUP,
  applyNewThreadSetupPatch,
  getReasoningForModel,
  getNewThreadPaymentSourceOptions,
  reconcileNewThreadSetupWithCodexCatalog,
  resolveNewThreadCodexServiceTier,
  resolveActiveThreadSearchMatchDate,
  resolveCompactThreadBadgeAppearance,
  resolveSelectedThreadRunningCodexMessage,
  resolveThreadSearchHighlightQuery,
  threadSearchExcerpt,
} from "../chatroom-thread-panel";
import immutable from "immutable";
import { COLORS } from "@cocalc/util/theme";
import { getCodexSubscriptionDisplayName } from "../codex-subscription-label";

describe("new thread setup patching", () => {
  it("keeps generated subscription names stable when recency order changes", () => {
    const first = { id: "a", updatedAt: "2026-09-19T00:00:00Z" };
    const second = { id: "b", updatedAt: "2026-09-19T00:00:00Z" };
    expect(getCodexSubscriptionDisplayName(first, [second, first])).toBe(
      "ChatGPT",
    );
    expect(getCodexSubscriptionDisplayName(second, [second, first])).toBe(
      "ChatGPT - 2",
    );
  });

  it("lists each ChatGPT subscription as an exact new-chat source", () => {
    const options = getNewThreadPaymentSourceOptions({
      source: "subscription",
      hasSubscription: true,
      hasProjectApiKey: false,
      hasAccountApiKey: false,
      hasSiteApiKey: false,
      sharedHomeMode: "disabled",
      subscriptions: [
        {
          id: "credential-normal",
          email: "normal@example.com",
          plan: "pro",
          updatedAt: "2026-09-19T00:00:00Z",
        },
        {
          id: "credential-security",
          label: "Security review",
          email: "security@example.com",
          plan: "pro",
          updatedAt: "2026-09-19T00:00:00Z",
        },
      ],
    });

    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "subscription:credential-normal",
          label: "ChatGPT",
        }),
        expect.objectContaining({
          value: "subscription:credential-security",
          label: "Security review",
        }),
      ]),
    );
    expect(options.some(({ value }) => value === "subscription")).toBe(false);
  });

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

  it("uses capabilities advertised for a dynamic Codex model", () => {
    const models = [
      {
        value: "gpt-6-astra",
        reasoning: [
          {
            id: "ultra" as const,
            label: "Ultra",
            description: "Maximum reasoning with task delegation.",
            default: true,
          },
        ],
        serviceTiers: ["fast"],
      },
    ];

    expect(
      getReasoningForModel({
        models,
        modelValue: "gpt-6-astra",
      }),
    ).toBe("ultra");
    expect(
      resolveNewThreadCodexServiceTier({
        models,
        model: "gpt-6-astra",
        serviceTier: "fast",
      }),
    ).toBe("fast");
  });

  it("drops Fast mode when the advertised model does not support it", () => {
    expect(
      resolveNewThreadCodexServiceTier({
        models: [{ value: "account-limited-model", serviceTiers: [] }],
        model: "account-limited-model",
        serviceTier: "fast",
      }),
    ).toBe("standard");
  });

  it("replaces an unavailable saved model with the advertised default", () => {
    const setup = applyNewThreadSetupPatch(DEFAULT_NEW_THREAD_SETUP, {
      model: "retired-model",
      codexConfig: {
        ...DEFAULT_NEW_THREAD_SETUP.codexConfig,
        model: "retired-model",
        reasoning: "high",
        serviceTier: "fast",
      },
    });
    const reconciled = reconcileNewThreadSetupWithCodexCatalog({
      setup,
      catalog: [
        {
          model: "gpt-6-astra",
          displayName: "GPT-6-Astra",
          description: "Current model",
          default: true,
          reasoning: [{ id: "medium", description: "Medium", default: true }],
          serviceTiers: [],
        },
      ],
    });

    expect(reconciled.model).toBe("gpt-6-astra");
    expect(reconciled.codexConfig).toMatchObject({
      model: "gpt-6-astra",
      reasoning: "medium",
      serviceTier: "standard",
    });
  });

  it("persists a catalog downgrade from Fast to Standard", () => {
    const setup = applyNewThreadSetupPatch(DEFAULT_NEW_THREAD_SETUP, {
      model: "gpt-6-astra",
      codexConfig: {
        ...DEFAULT_NEW_THREAD_SETUP.codexConfig,
        model: "gpt-6-astra",
        reasoning: "medium",
        serviceTier: "fast",
      },
    });
    const reconciled = reconcileNewThreadSetupWithCodexCatalog({
      setup,
      catalog: [
        {
          model: "gpt-6-astra",
          displayName: "GPT-6-Astra",
          description: "Current model",
          default: true,
          reasoning: [{ id: "medium", description: "Medium", default: true }],
          serviceTiers: [],
        },
      ],
    });

    expect(reconciled.codexConfig.serviceTier).toBe("standard");
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

describe("resolveActiveThreadSearchMatchDate", () => {
  it("clears the active match when the find UI is closed", () => {
    expect(
      resolveActiveThreadSearchMatchDate({
        threadSearchOpen: false,
        matchCount: 2,
        normalizedCursor: 1,
        threadSearchMatches: ["111", "222"],
      }),
    ).toBeUndefined();
  });

  it("returns the current match when the find UI is open", () => {
    expect(
      resolveActiveThreadSearchMatchDate({
        threadSearchOpen: true,
        matchCount: 2,
        normalizedCursor: 1,
        threadSearchMatches: ["111", "222"],
      }),
    ).toBe("222");
  });
});

describe("resolveThreadSearchHighlightQuery", () => {
  it("clears highlights when the find UI is closed", () => {
    expect(
      resolveThreadSearchHighlightQuery({
        threadSearchOpen: false,
        threadSearchQuery: "hello",
      }),
    ).toBe("");
  });

  it("keeps highlights active while the find UI is open", () => {
    expect(
      resolveThreadSearchHighlightQuery({
        threadSearchOpen: true,
        threadSearchQuery: "hello",
      }),
    ).toBe("hello");
  });
});

describe("threadSearchExcerpt", () => {
  it("keeps the matching context and removes markup", () => {
    const text = `${"prefix ".repeat(30)}<strong>needle</strong> ${"suffix ".repeat(30)}`;
    const excerpt = threadSearchExcerpt(text, "needle", 90);
    expect(excerpt).toContain("needle");
    expect(excerpt).not.toContain("<strong>");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("resolveSelectedThreadRunningCodexMessage", () => {
  it("recognizes a generating ACP turn without acp_account_id", () => {
    const running = {
      acp_log_key: "thread-1:message-1",
      generating: true,
      message_id: "message-1",
      thread_id: "thread-1",
      date: new Date("2026-07-11T00:00:00Z"),
    } as any;

    expect(resolveSelectedThreadRunningCodexMessage([running])).toBe(running);
  });

  it("picks the newest generating codex turn", () => {
    const older = {
      acp_account_id: "acp-1",
      generating: true,
      date: new Date("2026-04-12T10:00:00Z"),
    } as any;
    const newer = {
      acp_account_id: "acp-2",
      generating: true,
      date: new Date("2026-04-12T10:01:00Z"),
    } as any;
    expect(resolveSelectedThreadRunningCodexMessage([older, newer])).toBe(
      newer,
    );
  });

  it("ignores stale generating rows when ACP state is terminal", () => {
    const stale = {
      acp_account_id: "acp-1",
      generating: true,
      message_id: "msg-stale",
      date: new Date("2026-04-12T10:00:00Z"),
    } as any;
    expect(
      resolveSelectedThreadRunningCodexMessage(
        [stale],
        immutable.Map<string, string>().set("message:msg-stale", "error"),
      ),
    ).toBeUndefined();
  });

  it("ignores stale generating rows behind a newer terminal ACP turn", () => {
    const stale = {
      acp_account_id: "acp-1",
      generating: true,
      message_id: "msg-stale",
      date: new Date("2026-04-12T10:00:00Z"),
    } as any;
    const newer = {
      acp_account_id: "acp-1",
      generating: false,
      message_id: "msg-newer",
      date: new Date("2026-04-12T10:01:00Z"),
    } as any;
    expect(
      resolveSelectedThreadRunningCodexMessage([stale, newer]),
    ).toBeUndefined();
  });

  it("ignores stale generating rows behind a newer interrupted ACP turn", () => {
    const stale = {
      acp_account_id: "acp-1",
      generating: true,
      message_id: "msg-stale",
      date: new Date("2026-04-12T10:00:00Z"),
    } as any;
    const newer = {
      acp_account_id: "acp-1",
      acp_interrupted: true,
      generating: false,
      message_id: "msg-newer",
      date: new Date("2026-04-12T10:01:00Z"),
    } as any;
    expect(
      resolveSelectedThreadRunningCodexMessage([stale, newer]),
    ).toBeUndefined();
  });

  it("ignores interrupted or non-generating codex rows", () => {
    const interrupted = {
      acp_account_id: "acp-1",
      generating: true,
      acp_interrupted: true,
    } as any;
    const complete = {
      acp_account_id: "acp-2",
      generating: false,
    } as any;
    expect(
      resolveSelectedThreadRunningCodexMessage([interrupted, complete]),
    ).toBeUndefined();
  });
});
