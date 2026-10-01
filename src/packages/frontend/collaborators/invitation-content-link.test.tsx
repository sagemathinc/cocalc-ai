import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  InvitationContentLink,
  invitationTargetFromContext,
} from "./invitation-content-link";

const project_id = "22222222-2222-4222-8222-222222222222";
const target = {
  project_id,
  kind: "agent" as const,
  resource_id: "agent-thread:stable",
  label: "Authored label",
};

test("continuation uses only a versioned target bound to the invitation project", () => {
  expect(
    invitationTargetFromContext(
      { people_invitation: { version: 1, target } },
      project_id,
    ),
  ).toEqual(target);
  expect(
    invitationTargetFromContext(
      { people_invitation: { version: 2, target } },
      project_id,
    ),
  ).toBeUndefined();
  expect(
    invitationTargetFromContext(
      { people_invitation: { version: 1, target } },
      "other",
    ),
  ).toBeUndefined();
  expect(
    invitationTargetFromContext({ url: "https://example.com" }, project_id),
  ).toBeUndefined();
  expect(
    invitationTargetFromContext(
      { people_invitation: { version: 1, target: { ...target, kind: "url" } } },
      project_id,
    ),
  ).toBeUndefined();
});

test("content continuation is a keyboard reachable explicit stable-ID link, not runtime startup", async () => {
  const user = userEvent.setup();
  render(<InvitationContentLink target={target} projectId={project_id} />);
  const link = screen.getByRole("link", { name: "Open agent: Authored label" });
  expect(link).toHaveAttribute(
    "href",
    `/people/conversations/project/${project_id}/resource/agent/agent-thread%3Astable`,
  );
  await user.tab();
  expect(link).toHaveFocus();
});

test("mismatched targets cannot render an open action", () => {
  render(<InvitationContentLink target={target} projectId="other" />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
