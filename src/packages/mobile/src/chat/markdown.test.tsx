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
  ).toHaveLength(3);
  expect(
    view.root.findAllByProps({ accessibilityLabel: "Scrollable table" }).length,
  ).toBeGreaterThan(0);
  const copy = view.root.findByProps({ accessibilityLabel: "Copy code block" });
  await act(async () => copy.props.onPress());
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith("x = 1\n");
  await act(async () => view.unmount());
});

it("wraps code without changing copied whitespace and reports copy failures", async () => {
  let view: any;
  const content = "a very long line with trailing spaces  \n\n";
  await act(async () => {
    view = create(<Markdown value={`\`\`\`text\n${content}\`\`\``} />);
  });
  const button = (name: string) =>
    view.root.findByProps({
      accessibilityRole: "button",
      accessibilityLabel: name,
    });
  await act(async () => button("Wrap code").props.onPress());
  expect(button("Unwrap code").props.accessibilityState.selected).toBe(true);
  expect(
    view.root.findAllByProps({ accessibilityLabel: "Scrollable code block" }),
  ).toHaveLength(0);
  await act(async () => button("Copy code block").props.onPress());
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(content);
  expect(
    view.root.findByProps({ accessibilityLiveRegion: "polite" }).props.children,
  ).toBe("Copied");
  (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(
    new Error("Unavailable"),
  );
  await act(async () => button("Copy code block").props.onPress());
  expect(
    view.root.findByProps({ accessibilityLiveRegion: "polite" }).props.children,
  ).toContain("Could not copy");
  await act(async () => button("Unwrap code").props.onPress());
  expect(
    view.root.findAllByProps({ accessibilityLabel: "Scrollable code block" }),
  ).toHaveLength(1);
  await act(async () => view.unmount());
});

it("preserves numeric table alignment and exposes column headings", async () => {
  let view: any;
  await act(async () => {
    view = create(
      <Markdown value={"| Item | Count |\n|:---|---:|\n| Tests | 42 |"} />,
    );
  });
  const headings = view.root.findAllByProps({ accessibilityRole: "header" });
  expect(headings).toHaveLength(2);
  expect(headings[1].props.style).toContainEqual({ textAlign: "right" });
  await act(async () => view.unmount());
});
