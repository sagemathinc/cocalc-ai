import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineReviewCards } from "./inline-review-cards";
import type { InlineReviewCardsProps } from "./inline-review-cards";
import type { GitReviewCommentV2 } from "../git-review-store";

jest.mock("@cocalc/frontend/app-framework", () => require("react"));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => <div>{value}</div>,
}));
jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: ({ value, onChange, onBlur, cacheId, placeholder }: any) => (
    <textarea
      aria-label={placeholder}
      data-cache-id={cacheId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onBlur?.()}
    />
  ),
}));

const comment: GitReviewCommentV2 = {
  id: "saved-comment",
  file_path: "a.ts",
  side: "old",
  line: 10,
  body_md: "Saved **Markdown** ![image](/blobs/example.png)",
  status: "submitted",
  created_at: 1,
  updated_at: 1,
  local_revision: 1,
};
function props(): InlineReviewCardsProps {
  return {
    filePath: "a.ts",
    editorHistoryScope: "account:alice:commit:one",
    fontSize: 14,
    lineComments: [comment],
    anchor: { filePath: "a.ts", side: "new", line: 12 },
    anchorId: "new:12",
    showDraft: false,
    activeDraftBody: "",
    activeEditingBody: "",
    pendingKey: "",
    onDraftBodyChange: jest.fn(),
    onCancelDraft: jest.fn(),
    onOpenEdit: jest.fn(),
    onEditingBodyChange: jest.fn(),
    onCancelEdit: jest.fn(),
    onCreateComment: jest.fn().mockResolvedValue(undefined),
    onUpdateComment: jest.fn().mockResolvedValue(undefined),
    onResolveComment: jest.fn().mockResolvedValue(undefined),
    onReopenComment: jest.fn().mockResolvedValue(undefined),
  };
}

test("saved comment actions preserve record identity and support keyboard activation", async () => {
  const user = userEvent.setup();
  const p = props();
  const { rerender } = render(<InlineReviewCards {...p} />);
  expect(screen.getByText(comment.body_md)).not.toBeNull();
  const edit = screen.getByRole("button", { name: "Edit", exact: true });
  edit.focus();
  await user.keyboard("{Enter}");
  expect(p.onOpenEdit).toHaveBeenCalledWith(comment);
  await user.click(screen.getByRole("button", { name: "Resolve" }));
  expect(p.onResolveComment).toHaveBeenCalledWith(comment.id);
  rerender(
    <InlineReviewCards
      {...p}
      lineComments={[{ ...comment, status: "resolved" }]}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Reopen" }));
  expect(p.onReopenComment).toHaveBeenCalledWith(comment.id);
});

test("recovered alternatives explain acceptance and retain keyboard actions", async () => {
  const user = userEvent.setup();
  const p = props();
  const alternative = { ...comment, status: "conflict" as const };
  render(<InlineReviewCards {...p} lineComments={[alternative]} />);
  expect(
    screen.getByText(/Recovered local alternative.*Not sent to the agent/),
  ).toBeVisible();
  screen.getByRole("button", { name: "Edit", exact: true }).focus();
  await user.keyboard("{Enter}");
  expect(p.onOpenEdit).toHaveBeenCalledWith(alternative);
  screen.getByRole("button", { name: "Resolve", exact: true }).focus();
  await user.keyboard("{Enter}");
  expect(p.onResolveComment).toHaveBeenCalledWith(alternative.id);
});

test("edit keeps the legacy cache identity through layout changes and saves buffered text", async () => {
  const user = userEvent.setup();
  const p = {
    ...props(),
    activeEditingId: comment.id,
    activeEditingBody: comment.body_md,
  };
  const { rerender } = render(<InlineReviewCards {...p} inset={92} />);
  const editor = screen.getByRole("textbox");
  expect(editor.getAttribute("data-cache-id")).toBe(
    "account:alice:commit:one:inline-edit:a.ts:saved-comment",
  );
  await user.clear(editor);
  await user.type(editor, "Updated comment");
  rerender(<InlineReviewCards {...p} inset={0} fontSize={18} />);
  expect(screen.getByRole("textbox")).toBe(editor);
  expect((editor as HTMLTextAreaElement).value).toBe("Updated comment");
  await user.click(screen.getByRole("button", { name: /Save/ }));
  expect(p.onUpdateComment).toHaveBeenCalledWith(comment.id, "Updated comment");
});

test("draft uses the unchanged anchor and scoped cache identity", async () => {
  const user = userEvent.setup();
  const p = { ...props(), lineComments: [], showDraft: true };
  render(<InlineReviewCards {...p} />);
  const editor = screen.getByRole("textbox");
  expect(editor.getAttribute("data-cache-id")).toBe(
    "account:alice:commit:one:inline-draft:a.ts:new:12",
  );
  await user.type(editor, "New comment");
  await user.click(screen.getByRole("button", { name: /Add comment/ }));
  expect(p.onCreateComment).toHaveBeenCalledWith(p.anchor, "New comment");
});
