import React from "react";
const { act, create } = require("react-test-renderer");
import { ChatSettings } from "./settings";
import { getActiveSiteSession } from "../cocalc/session-registry";
jest.mock("../cocalc/codex-models", () => ({
  getProjectCodexModels: (
    session: any,
    project: string,
    credentialId?: string,
    refresh?: boolean,
  ) =>
    session.hubApi.projects.getCodexUsageStatus({
      project_id: project,
      include_models: true,
      credential_id: credentialId,
      ...(refresh ? { refresh_models: true } : {}),
    }),
}));
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: jest.fn(),
}));
jest.mock("../preview/fixtures", () => ({ isPreviewProfile: () => false }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: any;
const find = (label: string) =>
  renderer.root.findAll(
    (n: any) => n.type === "Pressable" && n.props.accessibilityLabel === label,
  )[0];
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

it("refreshes a ChatGPT plan model catalog on demand", async () => {
  const getModels = jest
    .fn()
    .mockResolvedValueOnce({
      models: [
        {
          model: "gpt-6-astra",
          displayName: "gpt-6-astra",
          reasoning: [],
          serviceTiers: [],
        },
      ],
    })
    .mockResolvedValue({
      models: [
        {
          model: "gpt-6-sol",
          displayName: "gpt-6-sol",
          reasoning: [],
          serviceTiers: [],
        },
      ],
    });
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: {
      system: {
        getCodexPaymentSource: async () => ({
          source: "subscription",
          credentialId: "credential",
          subscriptionRevision: "revision",
        }),
      },
      projects: { getCodexUsageStatus: getModels },
    },
  } as any);
  await act(async () => {
    renderer = create(
      <ChatSettings
        profile="p"
        project="project"
        thread="thread"
        client={{ updateCodexThreadConfig: jest.fn() } as any}
        onClose={() => {}}
      />,
    );
  });
  expect(find("gpt-6-astra")).toBeDefined();
  await act(async () => find("Refresh ChatGPT models").props.onPress());
  expect(getModels).toHaveBeenLastCalledWith({
    project_id: "project",
    include_models: true,
    credential_id: "credential",
    refresh_models: true,
  });
  expect(find("gpt-6-sol")).toBeDefined();
});
it("loads account-specific models and saves settings without losing session configuration", async () => {
  const payment = {
    source: "subscription",
    hasSubscription: true,
    credentialId: "credential",
    subscriptionRevision: "revision",
  };
  const getModels = jest.fn().mockResolvedValue({
    models: [
      {
        model: "test-model",
        displayName: "My plan model",
        reasoning: [{ id: "high" }],
        serviceTiers: [],
      },
    ],
  });
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: {
      system: { getCodexPaymentSource: async () => payment },
      projects: { getCodexUsageStatus: getModels },
    },
  } as any);
  const save = jest.fn().mockResolvedValue(undefined),
    close = jest.fn();
  await act(async () => {
    renderer = create(
      <ChatSettings
        profile="p"
        project="project"
        thread="thread"
        client={{ updateCodexThreadConfig: save } as any}
        config={{
          workingDirectory: "/work",
          sessionId: "session",
          model: "old",
        }}
        onClose={close}
      />,
    );
  });
  expect(getModels).toHaveBeenCalledWith({
    project_id: "project",
    include_models: true,
    credential_id: "credential",
  });
  await act(async () => find("My plan model").props.onPress());
  await act(async () => find("high").props.onPress());
  await act(async () => find("Save agent settings").props.onPress());
  expect(save).toHaveBeenCalledWith({
    thread_id: "thread",
    acp_config: {
      workingDirectory: "/work",
      sessionId: "session",
      model: "test-model",
      reasoning: "high",
      serviceTier: undefined,
    },
  });
  expect(close).toHaveBeenCalled();
});
it("keeps settings open after a failed save", async () => {
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: {
      system: {
        getCodexPaymentSource: async () => ({ source: "account-api-key" }),
      },
    },
  } as any);
  const close = jest.fn();
  await act(async () => {
    renderer = create(
      <ChatSettings
        profile="p"
        project="project"
        thread="thread"
        client={
          {
            updateCodexThreadConfig: async () => {
              throw Error("offline");
            },
          } as any
        }
        onClose={close}
      />,
    );
  });
  await act(async () => find("Save agent settings").props.onPress());
  expect(close).not.toHaveBeenCalled();
  expect(
    renderer.root.findByProps({ accessibilityRole: "alert" }).props.children,
  ).toBe("offline");
});

it("selects a non-default ChatGPT credential even when hasSubscription is false", async () => {
  const lookup = jest.fn(async ({ credential_id }: any) => ({
    source: credential_id ? "subscription" : "account-api-key",
    hasSubscription: !!credential_id,
    hasAccountApiKey: true,
    credentialId: credential_id,
    subscriptions: [{ id: "personal", label: "My Pro", isDefault: false }],
  }));
  const setPaymentSelections = jest.fn().mockResolvedValue({ updated: 1 });
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: {
      system: { getCodexPaymentSource: lookup },
      agent: { setPaymentSelections },
      projects: {
        getCodexUsageStatus: async () => ({
          models: [
            {
              model: "test",
              displayName: "Test model",
              reasoning: [],
              serviceTiers: [],
            },
          ],
        }),
      },
    },
  } as any);
  const save = jest.fn();
  await act(async () => {
    renderer = create(
      <ChatSettings
        profile="p"
        project="project"
        thread="t"
        config={{ model: "test", serviceTier: "fast", reasoning: "high" }}
        client={{ updateCodexThreadConfig: save } as any}
        onClose={() => {}}
      />,
    );
  });
  expect(find("ChatGPT plan")).toBeUndefined();
  await act(async () => find("ChatGPT: My Pro").props.onPress());
  expect(find("Default speed").props.accessibilityState.selected).toBe(true);
  expect(find("Model default").props.accessibilityState.selected).toBe(true);
  expect(find("Save agent settings").props.accessibilityState.disabled).toBe(
    false,
  );
  expect(lookup).toHaveBeenLastCalledWith(
    expect.objectContaining({
      preference: "subscription",
      credential_id: "personal",
    }),
  );
  await act(async () => find("Save agent settings").props.onPress());
  // The subscription is this account's choice, not shared thread config.
  expect(setPaymentSelections).toHaveBeenCalledWith({
    targets: [{ project_id: "project", thread_id: "t" }],
    provider: "codex",
    selection: {
      version: 1,
      provider: "codex",
      mode: "credential",
      credential_id: "personal",
    },
  });
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      acp_config: expect.objectContaining({
        paymentSource: "subscription",
        serviceTier: undefined,
        reasoning: undefined,
      }),
    }),
  );
  expect(save.mock.calls[0][0].acp_config).not.toHaveProperty("credentialId");
});

it("shows the account's stored subscription for the agent, not one saved in the thread", async () => {
  const lookup = jest.fn(async ({ credential_id }: any) => ({
    source: "subscription",
    hasSubscription: true,
    credentialId: credential_id,
    subscriptions: [
      { id: "current", label: "Current plan" },
      { id: "removed", label: "Old plan" },
    ],
  }));
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: {
      system: { getCodexPaymentSource: lookup },
      agent: {
        getPaymentSelections: async () => ({
          selections: [
            {
              project_id: "project",
              thread_id: "t",
              provider: "codex",
              selection: {
                version: 1,
                provider: "codex",
                mode: "credential",
                credential_id: "current",
              },
            },
          ],
          defaults: {},
        }),
      },
      projects: {
        getCodexUsageStatus: async () => ({
          models: [
            {
              model: "test",
              displayName: "Test",
              reasoning: [],
              serviceTiers: [],
            },
          ],
        }),
      },
    },
  } as any);
  await act(async () => {
    renderer = create(
      <ChatSettings
        profile="p"
        project="project"
        thread="t"
        config={{
          model: "test",
          paymentSource: "subscription",
          credentialId: "removed",
        }}
        client={{ updateCodexThreadConfig: jest.fn() } as any}
        onClose={() => {}}
      />,
    );
  });
  expect(find("ChatGPT: Current plan").props.accessibilityState.selected).toBe(
    true,
  );
  expect(lookup).toHaveBeenLastCalledWith(
    expect.objectContaining({ credential_id: "current" }),
  );
});

it("clears the stored subscription when another payment source is chosen, and keeps it otherwise", async () => {
  const { DEFAULT_CODEX_MODEL_NAME } = require("@cocalc/util/ai/codex");
  const setPaymentSelections = jest.fn().mockResolvedValue({ updated: 1 });
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: {
      system: {
        getCodexPaymentSource: async ({ preference, credential_id }: any) =>
          preference === "subscription"
            ? {
                source: "subscription",
                hasSubscription: true,
                credentialId: credential_id,
                subscriptions: [{ id: "current", label: "Current plan" }],
              }
            : { source: "account-api-key", hasAccountApiKey: true },
      },
      agent: {
        getPaymentSelections: async () => ({
          selections: [
            {
              project_id: "project",
              thread_id: "t",
              provider: "codex",
              selection: {
                version: 1,
                provider: "codex",
                mode: "credential",
                credential_id: "current",
              },
            },
          ],
          defaults: {},
        }),
        setPaymentSelections,
      },
      projects: {
        getCodexUsageStatus: async () => ({
          models: [
            {
              model: DEFAULT_CODEX_MODEL_NAME,
              displayName: "Plan model",
              reasoning: [],
              serviceTiers: [],
            },
          ],
        }),
      },
    },
  } as any);
  const render = async (save: jest.Mock) =>
    await act(async () => {
      renderer = create(
        <ChatSettings
          profile="p"
          project="project"
          thread="t"
          config={{
            model: DEFAULT_CODEX_MODEL_NAME,
            paymentSource: "subscription",
          }}
          client={{ updateCodexThreadConfig: save } as any}
          onClose={() => {}}
        />,
      );
    });

  // Saving without touching payment leaves the stored choice alone.
  const save = jest.fn().mockResolvedValue(undefined);
  await render(save);
  await act(async () => find("Save agent settings").props.onPress());
  expect(save).toHaveBeenCalled();
  expect(setPaymentSelections).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());

  // Choosing Automatic clears it.
  const save2 = jest.fn().mockResolvedValue(undefined);
  await render(save2);
  await act(async () => find("Automatic").props.onPress());
  await act(async () => find("Save agent settings").props.onPress());
  expect(setPaymentSelections).toHaveBeenCalledWith({
    targets: [{ project_id: "project", thread_id: "t" }],
    provider: "codex",
    selection: null,
  });
  expect(save2).toHaveBeenCalled();
});

it("falls back to the account's default subscription when the agent has none", async () => {
  const lookup = jest.fn(async ({ credential_id }: any) => ({
    source: "subscription",
    hasSubscription: true,
    credentialId: credential_id,
    subscriptions: [{ id: "account-default", label: "Personal Pro" }],
  }));
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: {
      system: { getCodexPaymentSource: lookup },
      agent: {
        getPaymentSelections: async () => ({
          selections: [],
          defaults: {
            codex: {
              version: 1,
              provider: "codex",
              mode: "credential",
              credential_id: "account-default",
            },
          },
        }),
      },
      projects: {
        getCodexUsageStatus: async () => ({
          models: [
            {
              model: "test",
              displayName: "Test",
              reasoning: [],
              serviceTiers: [],
            },
          ],
        }),
      },
    },
  } as any);
  await act(async () => {
    renderer = create(
      <ChatSettings
        profile="p"
        project="project"
        thread="t"
        config={{ model: "test", paymentSource: "subscription" }}
        client={{ updateCodexThreadConfig: jest.fn() } as any}
        onClose={() => {}}
      />,
    );
  });
  expect(find("ChatGPT: Personal Pro").props.accessibilityState.selected).toBe(
    true,
  );
  expect(lookup).toHaveBeenLastCalledWith(
    expect.objectContaining({ credential_id: "account-default" }),
  );
});
