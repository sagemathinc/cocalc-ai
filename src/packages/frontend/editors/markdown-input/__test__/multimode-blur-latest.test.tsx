/** @jest-environment jsdom */

import { act, render } from "@testing-library/react";
import MultiMarkdownInput from "../multimode";

// The markdown editor (CodeMirror) registers its blur handler once at mount.
// Capture the onBlur it received on FIRST render and make sure calling it
// later reaches the parent's latest onBlur, not a stale closure.
let firstMarkdownOnBlur: ((value: string) => void) | null = null;

jest.mock("../component", () => ({
  MarkdownInput: (props: any) => {
    if (firstMarkdownOnBlur == null) firstMarkdownOnBlur = props.onBlur;
    return <div data-testid="markdown-input" />;
  },
}));

jest.mock("@cocalc/frontend/editors/slate/editable-markdown", () => ({
  EditableMarkdown: () => <div data-testid="editable-markdown" />,
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({
    isFocused: true,
    isVisible: true,
    project_id: "project-1",
    path: "path-1",
  }),
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/misc", () => ({
  get_local_storage: () => undefined,
  set_local_storage: () => undefined,
}));

describe("MultiMarkdownInput markdown-mode blur", () => {
  beforeEach(() => {
    firstMarkdownOnBlur = null;
  });

  it("calls the latest onBlur and onChange, not the first-render ones", () => {
    const blurA = jest.fn();
    const blurB = jest.fn();
    const change = jest.fn();
    const { rerender } = render(
      <MultiMarkdownInput
        fixedMode="markdown"
        value=""
        onChange={change}
        onBlur={blurA}
      />,
    );
    expect(firstMarkdownOnBlur).toBeTruthy();
    rerender(
      <MultiMarkdownInput
        fixedMode="markdown"
        value="typed comment"
        onChange={change}
        onBlur={blurB}
      />,
    );
    act(() => {
      firstMarkdownOnBlur!("typed comment");
    });
    expect(change).toHaveBeenLastCalledWith("typed comment");
    expect(blurA).not.toHaveBeenCalled();
    expect(blurB).toHaveBeenCalledTimes(1);
  });
});
