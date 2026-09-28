import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";

let mockAccountId = "viewer";
let mockAiDisabled = false;
const mockGetResource = jest.fn();
const mockOpenCollaborators = jest.fn();
const mockOpenLibrary = jest.fn();
const mockOpenProject = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => mockAccountId,
  redux: {
    getStore: () => ({ getIn: () => mockAiDisabled }),
    getActions: () => ({ open_project: mockOpenProject }),
  },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        collaborators: { getResource: (...args) => mockGetResource(...args) },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/collaborators/navigation", () => ({
  openCollaborators: (...args) => mockOpenCollaborators(...args),
}));
jest.mock("@cocalc/frontend/agents/library-navigation", () => ({
  openLibrary: (...args) => mockOpenLibrary(...args),
}));

import {
  CollaborationReferenceLink,
  createCollaborationReference,
} from "./collaboration-reference";
import { getSlateToMarkdown } from "./register";
import { openResolvedCollaborationReference } from "@cocalc/frontend/collaborators/reference-picker-api";
import type { CollaborationResource } from "@cocalc/util/collaborators";

const reference: CollaborationReference = {
  version: 1,
  target: {
    project_id: "11111111-1111-4111-8111-111111111111",
    kind: "conversation",
    resource_id: "thread:1",
  },
  display_fallback: "Authored title",
  alias: "old-alias",
};
const resource = {
  ...reference.target,
  title: "Shared title",
  chat_path: "/current.chat",
  thread_id: "thread:1",
  personal: { alias: "viewer-alias" },
};

beforeEach(() => {
  mockAccountId = "viewer";
  mockAiDisabled = false;
  mockGetResource.mockReset().mockResolvedValue(resource);
  mockOpenCollaborators.mockReset();
  mockOpenLibrary.mockReset();
  mockOpenProject.mockReset().mockResolvedValue(undefined);
});

test("viewer alias is resolved by identity and keyboard activation reauthorizes before navigation", async () => {
  render(<CollaborationReferenceLink reference={reference} />);
  const button = await screen.findByRole("button", {
    name: "Open conversation @viewer-alias",
  });
  await userEvent.tab();
  expect(button).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(mockOpenCollaborators).toHaveBeenCalledWith({
      view: "conversations",
      projectId: reference.target.project_id,
      resourceKind: "conversation",
      resourceId: "thread:1",
    }),
  );
  expect(mockGetResource).toHaveBeenCalledTimes(2);
  expect(mockGetResource).toHaveBeenLastCalledWith(reference.target);
  expect(
    getSlateToMarkdown("collaboration-reference")({
      node: createCollaborationReference(reference),
    } as any),
  ).toBe(serializeCollaborationReference(reference));
});

test("removed access becomes unavailable without opening a route", async () => {
  render(<CollaborationReferenceLink reference={reference} />);
  const button = await screen.findByRole("button", {
    name: "Open conversation @viewer-alias",
  });
  mockGetResource.mockResolvedValue(null);
  await userEvent.click(button);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Unavailable reference",
  );
  expect(
    screen.queryByRole("button", { name: /viewer-alias/ }),
  ).not.toBeInTheDocument();
  expect(mockOpenCollaborators).not.toHaveBeenCalled();
  expect(mockOpenLibrary).not.toHaveBeenCalled();
});

test("unavailable or identity-mismatched metadata never replaces the authored label", async () => {
  mockGetResource.mockResolvedValue({
    ...resource,
    resource_id: "different",
    title: "Wrong identity",
  });
  render(<CollaborationReferenceLink reference={reference} />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Unavailable reference",
  );
  expect(
    screen.getByRole("button", { name: "Open conversation @old-alias" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Wrong identity")).not.toBeInTheDocument();
});

test("unavailable references offer the existing project invitation/access-request page", async () => {
  mockGetResource.mockResolvedValue(null);
  render(<CollaborationReferenceLink reference={reference} />);
  const access = await screen.findByRole("button", {
    name: "Request project access",
  });
  expect(mockOpenProject).not.toHaveBeenCalled();
  access.focus();
  await userEvent.keyboard("{Enter}");
  expect(mockOpenProject).toHaveBeenCalledWith({
    project_id: reference.target.project_id,
  });
  // An invitation accepted later needs no rebinding: activating the original link rechecks access.
  mockGetResource.mockResolvedValue(resource);
  await userEvent.click(
    screen.getByRole("button", { name: "Open conversation @old-alias" }),
  );
  await waitFor(() => expect(mockOpenCollaborators).toHaveBeenCalled());
  expect(
    screen.queryByRole("button", { name: "Request project access" }),
  ).not.toBeInTheDocument();
});

test("artifact opens the authorized catalog target, never an alias", async () => {
  const artifact = {
    ...reference,
    target: { ...reference.target, kind: "artifact" as const },
  };
  mockGetResource.mockResolvedValue({
    ...resource,
    ...artifact.target,
    entry_id: "a".repeat(64),
  });
  render(<CollaborationReferenceLink reference={artifact} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Open artifact @viewer-alias" }),
  );
  await waitFor(() =>
    expect(mockOpenLibrary).toHaveBeenCalledWith(
      reference.target.project_id,
      "a".repeat(64),
    ),
  );
  expect(mockOpenCollaborators).not.toHaveBeenCalled();
});

test("an agent reference only navigates and never calls the legacy agent context", async () => {
  const agent = {
    ...reference,
    target: { ...reference.target, kind: "agent" as const },
  };
  mockGetResource.mockResolvedValue({
    ...resource,
    ...agent.target,
    personal: undefined,
  });
  render(<CollaborationReferenceLink reference={agent} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Open agent Shared title" }),
  );
  await waitFor(() =>
    expect(mockOpenCollaborators).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKind: "agent",
        resourceId: agent.target.resource_id,
      }),
    ),
  );
});

test("AI opt-out opens authorized artifacts in the human workspace rather than the blocked Library shell", async () => {
  mockAiDisabled = true;
  const artifact = {
    ...reference,
    target: { ...reference.target, kind: "artifact" as const },
  };
  mockGetResource.mockResolvedValue({
    ...resource,
    ...artifact.target,
    entry_id: "a".repeat(64),
  });
  render(<CollaborationReferenceLink reference={artifact} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Open artifact @viewer-alias" }),
  );
  await waitFor(() =>
    expect(mockOpenCollaborators).toHaveBeenCalledWith({
      view: "conversations",
      projectId: artifact.target.project_id,
      resourceKind: "artifact",
      resourceId: artifact.target.resource_id,
    }),
  );
  expect(mockGetResource).toHaveBeenCalledTimes(2);
  expect(mockOpenLibrary).not.toHaveBeenCalled();
});

test("late open results after an account switch cannot navigate or expose old metadata", async () => {
  const view = render(<CollaborationReferenceLink reference={reference} />);
  const button = await screen.findByRole("button", {
    name: "Open conversation @viewer-alias",
  });
  let resolve!: (value: unknown) => void;
  mockGetResource.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await userEvent.click(button);
  mockAccountId = "new-viewer";
  mockGetResource.mockResolvedValue(null);
  view.rerender(<CollaborationReferenceLink reference={reference} />);
  await screen.findByRole("status");
  await act(async () => resolve(resource));
  expect(mockOpenCollaborators).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: /viewer-alias/ }),
  ).not.toBeInTheDocument();
});

test("authorization errors do not disclose server error metadata", async () => {
  mockGetResource.mockRejectedValue(Error("Sensitive project title"));
  render(<CollaborationReferenceLink reference={reference} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not check reference",
  );
  expect(screen.queryByText(/Sensitive project/)).not.toBeInTheDocument();
});

test.each(["agent", "artifact", "conversation"] as const)(
  "%s opens never fall back to a legacy route after access loss, archive, or lookup failure",
  async (kind) => {
    const bound = { ...reference, target: { ...reference.target, kind } };
    const authorized = {
      ...resource,
      ...bound.target,
      entry_id: "a".repeat(64),
    };
    mockGetResource.mockResolvedValue(authorized);
    render(<CollaborationReferenceLink reference={bound} />);
    await screen.findByRole("button", { name: `Open ${kind} @viewer-alias` });
    for (const result of [
      null,
      { ...authorized, archived: true },
      new Error("denied"),
    ]) {
      if (result instanceof Error) mockGetResource.mockRejectedValue(result);
      else mockGetResource.mockResolvedValue(result);
      await userEvent.click(screen.getByRole("button", { name: /^Open / }));
      if (result instanceof Error) await screen.findByRole("alert");
      else await screen.findByRole("status");
      expect(mockOpenLibrary).not.toHaveBeenCalled();
      expect(mockOpenCollaborators).not.toHaveBeenCalled();
    }
  },
);

test.each(["agent", "artifact", "conversation"] as const)(
  "%s lazy route loading rechecks that the initiating viewer is still current",
  async (kind) => {
    let current = true;
    const opening = openResolvedCollaborationReference(
      { ...resource, kind, entry_id: "a".repeat(64) } as CollaborationResource,
      () => current,
    );
    current = false;
    await opening;
    expect(mockOpenLibrary).not.toHaveBeenCalled();
    expect(mockOpenCollaborators).not.toHaveBeenCalled();
  },
);
