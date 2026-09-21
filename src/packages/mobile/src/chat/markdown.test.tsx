import React from "react";
const { act, create } = require("react-test-renderer");
import { Markdown } from "./markdown";
import * as Clipboard from "expo-clipboard";
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("renders semantic headings, lists, emphasis, code copy and scrollable tables", async () => {
  let view: any;
  await act(async () => {
    view = create(
      <Markdown
        value={
          "# Result\n\n- **Ready** and *reviewed*.\n\n```python\nx = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |"
        }
      />,
    );
  });
  expect(
    view.root.findAllByProps({ accessibilityRole: "header" }),
  ).toHaveLength(1);
  expect(
    view.root.findAllByProps({ accessibilityLabel: "Scrollable table" }).length,
  ).toBeGreaterThan(0);
  const copy = view.root.findByProps({ accessibilityLabel: "Copy code block" });
  await act(async () => copy.props.onPress());
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith("x = 1\n");
  await act(async () => view.unmount());
});
