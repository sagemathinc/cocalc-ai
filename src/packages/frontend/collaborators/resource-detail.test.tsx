import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResourceDetail } from "./resource-detail";
import type { DirectoryApi } from "./workspace-api";
import type { CollaborationResource } from "@cocalc/util/collaborators";

const mockEmbedded = jest.fn();
const mockLibrary = jest.fn();
jest.mock("./embedded-conversation", () => ({
  EmbeddedConversation: (props) => {
    mockEmbedded(props);
    return <div role="region" aria-label="Original workbench" />;
  },
}));
jest.mock("@cocalc/frontend/agents/library-entry", () => ({
  LibraryEntry: (props) => {
    mockLibrary(props);
    return <div role="region" aria-label="Existing artifact viewer" />;
  },
}));

const base: CollaborationResource = {
  project_id: "project",
  resource_id: "shared-agent",
  kind: "agent",
  title: "Shared research",
  chat_path: "/shared.chat",
  thread_id: "same-thread",
  participant_ids: [],
  created_at: 1,
  updated_at: 1,
  activity: 0,
};

beforeEach(() => jest.clearAllMocks());

test("an unnamed shared agent mounts the original workbench only on explicit open", async () => {
  const user = userEvent.setup();
  const api = {
    getResource: jest.fn().mockResolvedValue(base),
    ensureRoom: jest.fn(),
    setPersonalState: jest.fn(),
  } as unknown as DirectoryApi;
  render(
    <ResourceDetail
      api={api}
      accountId="alice"
      target={base}
      onChange={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  const open = await screen.findByRole("button", { name: "Open agent" });
  expect(mockEmbedded).not.toHaveBeenCalled();
  open.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("region", { name: "Original workbench" });
  expect(
    screen.getByRole("button", { name: "Back to resource overview" }),
  ).toHaveFocus();
  expect(mockEmbedded).toHaveBeenCalledWith({
    accountId: "alice",
    resource: base,
  });
  expect(api.ensureRoom).not.toHaveBeenCalled();
  expect(api.setPersonalState).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Back to resource overview" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Original workbench" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Open agent" }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Open agent" })).toHaveFocus(),
  );
});

test("an uncollected artifact uses the existing Library viewer with its catalog identity", async () => {
  const resource = {
    ...base,
    kind: "artifact" as const,
    resource_id: "artifact",
    entry_id: "entry",
  };
  render(
    <ResourceDetail
      api={
        {
          getResource: jest.fn().mockResolvedValue(resource),
        } as unknown as DirectoryApi
      }
      accountId="alice"
      target={resource}
      onChange={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  await screen.findByRole("region", { name: "Existing artifact viewer" });
  expect(mockLibrary).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "project",
      entryId: "entry",
      agents: [],
    }),
  );
});
