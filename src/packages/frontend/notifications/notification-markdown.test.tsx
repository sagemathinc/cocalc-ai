import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";
import { NotificationMarkdown } from "./notification-markdown";
import { notificationPreview } from "./markdown-preview";

const mockResolve = jest.fn();
const mockOpen = jest.fn();
jest.mock("@cocalc/frontend/collaborators/reference-picker-api", () => ({
  resolveCollaborationReference: (...args) => mockResolve(...args),
  openResolvedCollaborationReference: (...args) => mockOpen(...args),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useTypedRedux: () => "viewer",
}));

const reference = {
  version: 1 as const,
  target: {
    project_id: "11111111-1111-4111-8111-111111111111",
    kind: "artifact" as const,
    resource_id: "artifact:picture",
  },
  display_fallback: "Picture Lake",
};

beforeEach(() => {
  mockResolve.mockReset().mockResolvedValue({
    ...reference.target,
    title: "Picture Lake",
  });
  mockOpen.mockReset();
});

test("uses the shared reference renderer and keyboard activation does not open the surrounding row", async () => {
  const rowClick = jest.fn();
  const markdown = notificationPreview(
    serializeCollaborationReference(reference),
  );
  const { container } = render(
    <div onClick={rowClick}>
      <NotificationMarkdown value={`New reply:\n\n${markdown}`} />
    </div>,
  );
  const button = await screen.findByRole("button", {
    name: "Open artifact Picture Lake",
  });
  await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(1));
  await userEvent.tab();
  expect(button).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
  expect(mockResolve).toHaveBeenCalledTimes(2);
  expect(rowClick).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("data-collaboration-reference");
  fireEvent.click(screen.getByText("New reply:"));
  expect(rowClick).toHaveBeenCalledTimes(1);
});

test("renders old broken references as readable text, not a guessed destination", () => {
  const value =
    serializeCollaborationReference(reference).slice(0, 240) + "...";
  const { container } = render(<NotificationMarkdown value={value} />);
  expect(
    screen.getByText("Linked resource (open the conversation to view)."),
  ).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(mockResolve).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("%7B");
});
