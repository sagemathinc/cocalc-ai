import React from "react";
const { act, create } = require("react-test-renderer");
import { ChatSettings } from "./settings";
import { getActiveSiteSession } from "../cocalc/session-registry";
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
