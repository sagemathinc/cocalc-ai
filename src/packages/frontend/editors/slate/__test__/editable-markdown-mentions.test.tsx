/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react";
import { EditableMarkdown } from "../editable-markdown";

const submitMentions = jest.fn();

jest.mock("@cocalc/frontend/editors/markdown-input/mentions", () => ({
  submit_mentions: (...args: any[]) => submitMentions(...args),
}));

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

const ACCOUNT = "47d0393e-4814-4452-bb6c-35bac4cbd314";

// A chat composer outside any frame (the People page) has no frame context,
// so the editor must use the project and path it is given.
it("submits mentions for the given chat when there is no frame context", async () => {
  const submitMentionsRef = { current: undefined as any };
  render(
    <EditableMarkdown
      project_id="project-1"
      path="people/conversation.chat"
      value={`Hey <span class="user-mention" account-id=${ACCOUNT} >@Bella Welski</span> this is a test.`}
      submitMentionsRef={submitMentionsRef}
      actions={{ set_value: jest.fn() } as any}
      enableUpload={false}
      minimal
      hidePath
      disableWindowing
      noVfill
      showEditBar={false}
      height="auto"
    />,
  );
  await waitFor(() => expect(submitMentionsRef.current).toBeDefined());
  submitMentionsRef.current({ chat: "1" });
  expect(submitMentions).toHaveBeenCalledWith(
    "project-1",
    "people/conversation.chat",
    [expect.objectContaining({ account_id: ACCOUNT })],
  );
});
