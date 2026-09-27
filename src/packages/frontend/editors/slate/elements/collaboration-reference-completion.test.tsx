import { act, render, waitFor } from "@testing-library/react";
import { Transforms } from "slate";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";
import { EditableMarkdown } from "../editable-markdown";

let mockMentionOptions: any;
const mockApproval = jest.fn();
jest.mock("../slate-mentions", () => ({
  useMentions: (options) => {
    mockMentionOptions = options;
    return { onChange: () => {}, onKeyDown: () => {} };
  },
}));
jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));
jest.mock("@cocalc/frontend/agents/mention-context", () => ({
  useAgentMentionContext: () => ({ onSelect: mockApproval }),
}));
jest.mock("@cocalc/frontend/collaborators/reference-picker-api", () => ({
  resolveCollaborationReference: async () => null,
}));

test.each(["agent", "artifact", "conversation"] as const)(
  "Slate @ insertion stores a %s atom without invoking agent approval",
  async (kind) => {
    mockApproval.mockClear();
    const reference = {
      version: 1 as const,
      target: {
        project_id: "11111111-1111-4111-8111-111111111111",
        kind,
        resource_id: "stable-id",
      },
      display_fallback: "Shared work",
    };
    const markup = serializeCollaborationReference(reference);
    const getValueRef = { current: () => "" };
    render(
      <EditableMarkdown
        value="@same"
        getValueRef={getValueRef}
        is_current
        enableUpload={false}
        minimal
        hidePath
        disableWindowing
        noVfill
        showEditBar={false}
        height="auto"
      />,
    );
    await act(async () => {
      const { editor, insertMention } = mockMentionOptions;
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 5 },
      });
      insertMention(editor, markup);
    });
    await waitFor(() => expect(getValueRef.current()).toContain(markup));
    expect(
      mockMentionOptions.editor.children[0].children.some(
        (node) => node.type === "collaboration-reference",
      ),
    ).toBe(true);
    expect(mockApproval).not.toHaveBeenCalled();
  },
);
