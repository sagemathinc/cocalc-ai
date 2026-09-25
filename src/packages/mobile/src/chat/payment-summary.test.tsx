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
  const lookup = jest
    .fn()
    .mockResolvedValue({
      source: "subscription",
      credentialId: "c",
      subscriptions: [{ id: "c", label: "Personal Pro" }],
    });
  jest
    .mocked(getActiveSiteSession)
    .mockResolvedValue({
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
