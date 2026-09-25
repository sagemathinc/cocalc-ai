import React from "react";
const { act, create } = require("react-test-renderer");
import { Markdown, ProjectFileLinkContext } from "./markdown";
import * as Clipboard from "expo-clipboard";
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("opens project-file attachments through the current project's handoff", async () => {
  const open = jest.fn();
  let view: any;
  await act(async () => {
    view = create(
      <ProjectFileLinkContext.Provider value={open}>
        <Markdown value="[report.pdf](sandbox:/home/user/report.pdf)" />
      </ProjectFileLinkContext.Provider>,
    );
  });
  const link = view.root.findByProps({ accessibilityRole: "link" });
  await act(async () => link.props.onPress());
  expect(open).toHaveBeenCalledWith("sandbox:/home/user/report.pdf");
  await act(async () => view.unmount());
});
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

it("renders shared CoCalc tokens without dropping formulas, tasks, or mentions", async () => {
  let view: any;
  await act(async () => {
    view = create(
      <Markdown
        value={
          '- [x] Done\n- [ ] Pending\n\nHello <span class="user-mention" account-id=47d0393e-4814-4452-bb6c-35bac4cbd314>@William</span> #topic :smile: \\(x_1 + x_2\\)'
        }
      />,
    );
  });
  const json = JSON.stringify(view.toJSON());
  expect(json).toContain("@William");
  expect(json).toContain("#topic");
  expect(json).toContain("x_1 + x_2");
  expect(json).toContain("😄");
  expect(
    view.root.findAllByProps({ accessibilityLabel: "Completed" }).length,
  ).toBeGreaterThan(0);
  expect(
    view.root.findAllByProps({ accessibilityLabel: "Not completed" }).length,
  ).toBeGreaterThan(0);
  await act(async () => view.unmount());
});

it("renders the full phone preview corpus", async () => {
  const { MARKDOWN_SAMPLE } = require("../preview/markdown-sample");
  let view: any;
  await act(async () => {
    view = create(<Markdown value={MARKDOWN_SAMPLE} />);
  });
  expect(JSON.stringify(view.toJSON())).toContain("End of sample");
  expect(
    view.root.findAllByProps({ accessibilityLabel: "Copy code block" }),
  ).toHaveLength(2);
  await act(async () => view.unmount());
});

it("renders inline HTML formatting around Markdown without exposing tags", async () => {
  let view: any;
  await act(async () => {
    view = create(
      <Markdown
        value={
          '<u>**underlined bold**</u> and <a href="https://cocalc.ai">CoCalc</a> <script>bad()</script>'
        }
      />,
    );
  });
  const json = JSON.stringify(view.toJSON());
  expect(json).toContain("underlined bold");
  expect(json).toContain('"textDecorationLine":"underline"');
  expect(json).not.toContain("bad()");
  expect(json).not.toContain("<u>");
  expect(view.root.findAllByProps({ accessibilityRole: "link" })).toHaveLength(
    1,
  );
  await act(async () => view.unmount());
});
it("expands and collapses details while preserving Markdown content", async () => {
  let view: any;
  await act(async () => {
    view = create(
      <Markdown
        value={
          "<details>\n<summary>More results</summary>\n\n**Hidden result**\n\n</details>"
        }
      />,
    );
  });
  const button = () => view.root.findByProps({ accessibilityRole: "button" });
  expect(button().props.accessibilityState.expanded).toBe(false);
  expect(JSON.stringify(view.toJSON())).not.toContain("Hidden result");
  await act(async () => button().props.onPress());
  expect(button().props.accessibilityState.expanded).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain("Hidden result");
  await act(async () => button().props.onPress());
  expect(JSON.stringify(view.toJSON())).not.toContain("Hidden result");
  await act(async () => view.unmount());
});
it("loads an image and preserves its description if loading fails", async () => {
  let view: any;
  await act(async () => {
    view = create(
      <Markdown value="![A graph](https://example.com/plot.png)" />,
    );
  });
  const image = view.root.findByType("Image");
  expect(image.props.accessibilityLabel).toBe("A graph");
  await act(async () => image.props.onError());
  expect(JSON.stringify(view.toJSON())).toContain("Image unavailable: ");
  expect(JSON.stringify(view.toJSON())).toContain("A graph");
  await act(async () => view.unmount());
});
