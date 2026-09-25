import React from "react";
import NotFoundScreen from "../app/+not-found";
const { act, create } = require("react-test-renderer");
jest.mock("expo-router", () => ({
  Link: "Link",
  Stack: { Screen: "Screen" },
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("offers a named way back to saved accounts, replacing the broken route", async () => {
  let view: any;
  await act(async () => {
    view = create(<NotFoundScreen />);
  });
  const link = view.root.findByType("Link");
  expect(link.props.accessibilityRole).toBe("button");
  expect(link.props.children).toBe("Open saved accounts");
  expect(link.props.href).toBe("/");
  expect(link.props.replace).toBe(true);
  await act(async () => view.unmount());
});
