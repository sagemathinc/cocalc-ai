import { render, screen } from "@testing-library/react";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { emptyCollaborationPersonalState } from "@cocalc/util/collaborators";
import { ResourceList } from "./resource-list";

const resource: CollaborationResource = {
  project_id: "project",
  resource_id: "thread",
  kind: "conversation",
  title: "Shared work",
  chat_path: "/room.chat",
  participant_ids: [],
  created_at: 1,
  updated_at: 1,
  activity: 4,
  reason: "mention",
  personal: {
    ...emptyCollaborationPersonalState(),
    following: true,
    muted: true,
  },
};

test.each(["agent", "artifact"] as const)(
  "%s never displays conversation attention tags or reasons",
  (kind) => {
    render(<ResourceList items={[{ ...resource, kind }]} onOpen={jest.fn()} />);
    expect(screen.getByRole("button", { name: /Shared work/ })).toBeEnabled();
    for (const label of [
      "Unread",
      "Mention",
      "Following",
      "Muted",
      "You were mentioned",
    ])
      expect(screen.queryByText(label, { exact: true })).toBeNull();
  },
);

test("human conversations retain attention tags and reasons", () => {
  render(<ResourceList items={[resource]} onOpen={jest.fn()} />);
  for (const label of [
    "Unread",
    "Mention",
    "Following",
    "Muted",
    "You were mentioned",
  ])
    expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
});
