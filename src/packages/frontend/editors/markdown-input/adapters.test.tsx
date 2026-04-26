/** @jest-environment jsdom */

import { createRef } from "react";
import { render } from "@testing-library/react";
import { SlateRichTextAdapter } from "./adapters";

const editableMarkdownProps: any[] = [];

jest.mock("@cocalc/frontend/editors/slate/editable-markdown", () => ({
  EditableMarkdown: (props) => {
    editableMarkdownProps.push(props);
    return <div>Editable markdown</div>;
  },
}));

describe("SlateRichTextAdapter", () => {
  beforeEach(() => {
    editableMarkdownProps.length = 0;
  });

  it("passes enableUpload through to the rich text editor", () => {
    render(
      <SlateRichTextAdapter
        autoFocus={false}
        controlRef={createRef()}
        editBar2={createRef()}
        enableUpload={false}
        externalMultilinePasteAsCodeBlock={false}
        noVfill={false}
        onAltEnter={() => undefined}
        onChange={() => undefined}
        preserveBlankLines={true}
        saveDebounceMs={0}
        selectionRef={createRef()}
      />,
    );

    expect(editableMarkdownProps[0]?.enableUpload).toBe(false);
  });

  it("does not add a second scroll container around the rich text editor", () => {
    const { container } = render(
      <SlateRichTextAdapter
        autoFocus={false}
        controlRef={createRef()}
        editBar2={createRef()}
        externalMultilinePasteAsCodeBlock={false}
        height="120px"
        noVfill={false}
        onAltEnter={() => undefined}
        onChange={() => undefined}
        preserveBlankLines={true}
        saveDebounceMs={0}
        selectionRef={createRef()}
      />,
    );

    expect(container.firstChild).toHaveStyle({ overflow: "hidden" });
    expect(container.firstChild).not.toHaveStyle({ overflowY: "auto" });
  });
});
