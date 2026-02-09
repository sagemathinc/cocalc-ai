/** @jest-environment jsdom */

import { act, render } from "@testing-library/react";
import MultiMarkdownInput from "../multimode";

let latestEditableProps: any = null;

jest.mock("@cocalc/frontend/editors/slate/editable-markdown", () => ({
  EditableMarkdown: (props: any) => {
    latestEditableProps = props;
    return <div data-testid="editable-markdown" />;
  },
}));

jest.mock("../component", () => ({
  MarkdownInput: () => <div data-testid="markdown-input" />,
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

describe("MultiMarkdownInput stale callback guard", () => {
  beforeEach(() => {
    latestEditableProps = null;
  });

  it("ignores stale editor callbacks from an old cacheId", () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <MultiMarkdownInput
        fixedMode="editor"
        cacheId="draft-a"
        value=""
        onChange={onChange}
      />,
    );
    expect(latestEditableProps).toBeTruthy();
    const staleSetValue = latestEditableProps.actions.set_value;
    const staleShiftEnter = latestEditableProps.actions.shiftEnter;

    rerender(
      <MultiMarkdownInput
        fixedMode="editor"
        cacheId="draft-b"
        value=""
        onChange={onChange}
      />,
    );
    expect(latestEditableProps).toBeTruthy();
    const activeSetValue = latestEditableProps.actions.set_value;
    const activeShiftEnter = latestEditableProps.actions.shiftEnter;

    act(() => {
      staleSetValue("stale");
      staleShiftEnter("stale-shift");
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      activeSetValue("fresh");
      activeShiftEnter("fresh-shift");
    });
    expect(onChange).toHaveBeenNthCalledWith(1, "fresh");
    expect(onChange).toHaveBeenNthCalledWith(2, "fresh-shift");
  });
});

