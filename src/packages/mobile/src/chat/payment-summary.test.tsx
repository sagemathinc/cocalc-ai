import React from "react";
const { act, create } = require("react-test-renderer");
import { PaymentSummary } from "./payment-summary";
import { getActiveSiteSession } from "../cocalc/session-registry";
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: jest.fn(),
}));
jest.mock("../preview/fixtures", () => ({ isPreviewProfile: () => false }));
jest.mock("expo-router", () => ({
  useFocusEffect: (fn: () => void) => require("react").useEffect(fn, [fn]),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("shows the resolved named payment source and opens settings", async () => {
  const lookup = jest.fn().mockResolvedValue({
    source: "subscription",
    credentialId: "c",
    subscriptions: [{ id: "c", label: "Personal Pro" }],
  });
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: { system: { getCodexPaymentSource: lookup } },
  } as any);
  const open = jest.fn();
  let view: any;
  await act(async () => {
    view = create(
      <PaymentSummary
        profile="p"
        project="project"
        config={{ paymentSource: "subscription", credentialId: "c" }}
        onPress={open}
      />,
    );
  });
  const button = view.root.findAll(
    (n: any) =>
      n.type === "Pressable" && n.props.accessibilityRole === "button",
  )[0];
  expect(button.props.accessibilityLabel).toContain(
    "ChatGPT plan · Personal Pro",
  );
  expect(lookup).toHaveBeenCalledWith({
    project_id: "project",
    preference: "subscription",
    credential_id: "c",
  });
  await act(async () => button.props.onPress());
  expect(open).toHaveBeenCalled();
  await act(async () => view.unmount());
});

it("shows the subscription the account chose for the agent, else its default", async () => {
  const lookup = jest.fn(async ({ credential_id }: any) => ({
    source: "subscription",
    credentialId: credential_id,
    subscriptions: [
      { id: "agent-choice", label: "Team plan" },
      { id: "account-default", label: "Personal Pro" },
    ],
  }));
  const getPaymentSelections = jest.fn();
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: {
      system: { getCodexPaymentSource: lookup },
      agent: { getPaymentSelections },
    },
  } as any);
  const label = async () => {
    let view: any;
    await act(async () => {
      view = create(
        <PaymentSummary
          profile="p"
          project="project"
          thread="t"
          config={{ paymentSource: "subscription" }}
          onPress={() => {}}
        />,
      );
    });
    const text = view.root.findAll(
      (n: any) =>
        n.type === "Pressable" && n.props.accessibilityRole === "button",
    )[0].props.accessibilityLabel;
    await act(async () => view.unmount());
    return text;
  };
  const credential = (credential_id: string) => ({
    version: 1,
    provider: "codex",
    mode: "credential",
    credential_id,
  });

  getPaymentSelections.mockResolvedValue({
    selections: [
      {
        project_id: "project",
        thread_id: "t",
        provider: "codex",
        selection: credential("agent-choice"),
      },
    ],
    defaults: { codex: credential("account-default") },
  });
  expect(await label()).toContain("ChatGPT plan · Team plan");

  getPaymentSelections.mockResolvedValue({
    selections: [],
    defaults: { codex: credential("account-default") },
  });
  expect(await label()).toContain("ChatGPT plan · Personal Pro");
  expect(lookup).toHaveBeenLastCalledWith({
    project_id: "project",
    preference: "subscription",
    credential_id: "account-default",
  });
});

it("refreshes when settings may have changed the agent's private selection", async () => {
  const lookup = jest.fn(async ({ credential_id }: any) => ({
    source: "subscription",
    credentialId: credential_id,
    subscriptions: [
      { id: "a", label: "Plan A" },
      { id: "b", label: "Plan B" },
    ],
  }));
  let chosen = "a";
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
                credential_id: chosen,
              },
            },
          ],
          defaults: {},
        }),
      },
    },
  } as any);
  // The shared config does not change when the private selection does.
  const config = { paymentSource: "subscription" as const };
  const element = (revision: number) => (
    <PaymentSummary
      profile="p"
      project="project"
      thread="t"
      config={config}
      revision={revision}
      onPress={() => {}}
    />
  );
  let view: any;
  await act(async () => {
    view = create(element(0));
  });
  const label = () =>
    view.root.findAll(
      (n: any) =>
        n.type === "Pressable" && n.props.accessibilityRole === "button",
    )[0].props.accessibilityLabel;
  expect(label()).toContain("Plan A");
  chosen = "b";
  await act(async () => view.update(element(1)));
  expect(label()).toContain("Plan B");
  await act(async () => view.unmount());
});

it("shows project-managed payment for a harness other than Claude Code", async () => {
  jest.mocked(getActiveSiteSession).mockResolvedValue({ hubApi: {} } as any);
  let view: any;
  await act(async () => {
    view = create(
      <PaymentSummary
        profile="p"
        project="project"
        thread="t"
        harness="project-managed"
        onPress={() => {}}
      />,
    );
  });
  expect(JSON.stringify(view.toJSON())).toContain(
    "Project-managed credentials",
  );
  await act(async () => view.unmount());
});
