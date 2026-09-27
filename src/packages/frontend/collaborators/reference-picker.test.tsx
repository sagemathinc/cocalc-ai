import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";

let mockAccountId = "viewer";
const mockListResources = jest.fn();
const mockGetResource = jest.fn();
const mockWriteDraft = jest.fn();
const computedStyle = window.getComputedStyle;
beforeAll(() => {
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => computedStyle(element));
});
afterAll(() => jest.restoreAllMocks());
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store) => (store === "account" ? mockAccountId : Map()),
  redux: {
    getActions: () => ({ erase_active_key_handler: jest.fn() }),
    getStore: () => ({ get: () => mockAccountId }),
  },
}));
jest.mock("@cocalc/frontend/chat/use-chat-composer-draft", () => ({
  writeChatComposerDraft: (...args) => mockWriteDraft(...args),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        collaborators: {
          listResources: (...args) => mockListResources(...args),
          getResource: (...args) => mockGetResource(...args),
        },
      },
    },
  },
}));

import { ReferencePicker, ReferencePickerButton } from "./reference-picker";
import { ReferencePickerComposer } from "./reference-picker-composer";
import { parseCollaborationReference } from "@cocalc/util/collaboration-references";

const project_id = "11111111-1111-4111-8111-111111111111";
const base = {
  project_id,
  resource_id: "target-1",
  title: "Shared work",
  project_title: "Geometry",
  personal: { alias: "same" },
};
const items = ["agent", "artifact", "conversation"].map((kind) => ({
  ...base,
  kind,
}));
beforeEach(() => {
  mockAccountId = "viewer";
  mockListResources
    .mockReset()
    .mockResolvedValue({ items, coverage: "complete" });
  mockGetResource.mockReset();
  mockWriteDraft.mockReset().mockResolvedValue("draft plus reference");
});

test("keyboard opens picker, exposes type/project disambiguation, selects stable target and restores focus", async () => {
  const onSelect = jest.fn();
  render(<ReferencePickerButton projectId={project_id} onSelect={onSelect} />);
  await userEvent.tab();
  const trigger = screen.getByRole("button", { name: "Insert reference" });
  expect(trigger).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(
    (await screen.findByRole("dialog", { name: "Insert a reference" })).closest(
      ".collaborators-modal",
    ),
  ).not.toBeNull();
  const search = await screen.findByRole("textbox", {
    name: "Search titles or aliases",
  });
  await waitFor(() => expect(search).toHaveFocus());
  const conversation = await screen.findByRole("button", {
    name: "@same: Shared work Human conversation / Geometry / Unknown creator",
  });
  expect(
    screen.getByRole("button", {
      name: "@same: Shared work Agent / Geometry / Unknown creator",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: "@same: Shared work Artifact / Geometry / Unknown creator",
    }),
  ).toBeInTheDocument();
  await userEvent.tab();
  expect(screen.getByRole("combobox", { name: "Resource type" })).toHaveFocus();
  await userEvent.tab();
  expect(
    screen.getByRole("checkbox", { name: "Search all accessible projects" }),
  ).toHaveFocus();
  await userEvent.tab();
  await userEvent.tab();
  await userEvent.tab();
  expect(conversation).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledWith({
    version: 1,
    target: { project_id, resource_id: "target-1", kind: "conversation" },
    display_fallback: "Shared work",
    alias: "same",
  });
  expect(mockGetResource).not.toHaveBeenCalled();
  await waitFor(() => expect(trigger).toHaveFocus());
});

test("Escape cancels without selecting and restores trigger focus", async () => {
  const onSelect = jest.fn();
  render(<ReferencePickerButton onSelect={onSelect} />);
  const trigger = screen.getByRole("button", { name: "Insert reference" });
  await userEvent.click(trigger);
  await screen.findByRole("textbox", { name: "Search titles or aliases" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  expect(onSelect).not.toHaveBeenCalled();
});

test("can broaden project context through one bounded global search", async () => {
  render(
    <ReferencePicker
      open
      projectId={project_id}
      onSelect={jest.fn()}
      onClose={jest.fn()}
    />,
  );
  await screen.findByRole("button", { name: /Human conversation/ });
  expect(mockListResources).toHaveBeenLastCalledWith(
    expect.objectContaining({ project_id, limit: 25 }),
  );
  await userEvent.click(
    screen.getByRole("checkbox", { name: "Search all accessible projects" }),
  );
  await waitFor(() =>
    expect(mockListResources).toHaveBeenLastCalledWith(
      expect.objectContaining({ project_id: undefined, limit: 25 }),
    ),
  );
});

test("search is server-paged, bounded, exposes coverage and replaces rather than accumulates pages", async () => {
  mockListResources
    .mockResolvedValueOnce({
      items,
      coverage: "indexing",
      next: "opaque-cursor",
    })
    .mockResolvedValue({
      items: [
        {
          ...base,
          kind: "artifact",
          title: "Unnamed artifact",
          personal: undefined,
        },
      ],
      coverage: "complete",
    });
  render(<ReferencePicker open onSelect={jest.fn()} onClose={jest.fn()} />);
  await screen.findByRole("button", { name: /Next references/ });
  expect(screen.getByText(/still being indexed/)).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Next references" }),
  );
  expect(screen.getByRole("heading", { name: "References" })).toHaveFocus();
  await screen.findByRole("button", { name: /Unnamed artifact/ });
  expect(mockListResources).toHaveBeenLastCalledWith(
    expect.objectContaining({
      after: "opaque-cursor",
      scope: "all",
      limit: 25,
    }),
  );
  expect(
    screen.queryByRole("button", { name: /@same/ }),
  ).not.toBeInTheDocument();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Search titles or aliases" }),
    "new title",
  );
  await waitFor(() =>
    expect(mockListResources).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "new title", after: undefined }),
    ),
  );
});

test("late results from an old account cannot populate a new viewer's picker", async () => {
  let resolve!: (page: unknown) => void;
  mockListResources
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ items: [], coverage: "complete" });
  const view = render(
    <ReferencePicker open onSelect={jest.fn()} onClose={jest.fn()} />,
  );
  await waitFor(() => expect(mockListResources).toHaveBeenCalledTimes(1));
  mockAccountId = "new-viewer";
  view.rerender(
    <ReferencePicker open onSelect={jest.fn()} onClose={jest.fn()} />,
  );
  await screen.findByText("No matching references.");
  await act(async () => resolve({ items, coverage: "complete" }));
  expect(
    screen.queryByRole("button", { name: /Shared work/ }),
  ).not.toBeInTheDocument();
});

test("changing search immediately hides old results and ignores late responses", async () => {
  let resolve!: (page: unknown) => void;
  mockListResources
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ items: [], coverage: "complete" });
  render(<ReferencePicker open onSelect={jest.fn()} onClose={jest.fn()} />);
  await waitFor(() => expect(mockListResources).toHaveBeenCalledTimes(1));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Search titles or aliases" }),
    "new title",
  );
  await screen.findByText("No matching references.");
  await act(async () => resolve({ items, coverage: "complete" }));
  expect(
    screen.queryByRole("button", { name: /Shared work/ }),
  ).not.toBeInTheDocument();
});

test("errors are announced and can be retried without exposing server details", async () => {
  mockListResources.mockRejectedValueOnce(Error("Sensitive metadata"));
  render(<ReferencePicker open onSelect={jest.fn()} onClose={jest.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load references",
  );
  expect(screen.queryByText(/Sensitive metadata/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: /Human conversation/ });
});

test("composer inserts a bound reference at the saved cursor without invoking an agent", async () => {
  const control = {
    captureSelection: jest.fn(() => ({ line: 2, ch: 4 })),
    insertText: jest.fn(() => true),
    focus: jest.fn(() => true),
  };
  render(
    <ReferencePickerComposer
      projectId={project_id}
      inputControlRef={{ current: control }}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Insert reference" }),
  );
  await userEvent.click(
    await screen.findByRole("button", {
      name: "@same: Shared work Agent / Geometry / Unknown creator",
    }),
  );
  expect(control.insertText).toHaveBeenCalledTimes(1);
  const [markup, position] = control.insertText.mock.calls[0] as unknown as [
    string,
    object,
  ];
  expect(parseCollaborationReference(markup.trim())?.target).toEqual({
    project_id,
    kind: "agent",
    resource_id: "target-1",
  });
  expect(position).toEqual({ line: 2, ch: 4 });
  await waitFor(() => expect(control.focus).toHaveBeenCalled());
  expect(mockGetResource).not.toHaveBeenCalled();
});

test("Share artifact to conversation chooses another destination rather than changing the current composer", async () => {
  const control = {
    captureSelection: jest.fn(() => ({ line: 0, ch: 2 })),
    insertText: jest.fn(() => true),
    focus: jest.fn(() => true),
  };
  const destination = {
    ...base,
    kind: "conversation",
    resource_id: "other-conversation",
    project_id: "22222222-2222-4222-8222-222222222222",
    project_title: "Topology",
    title: "Other discussion",
    chat_path: "/other.chat",
    thread_id: "other-thread",
  };
  mockListResources
    .mockResolvedValueOnce({
      items: [{ ...base, kind: "artifact" }],
      coverage: "complete",
    })
    .mockResolvedValue({ items: [destination], coverage: "complete" });
  mockGetResource.mockImplementation(async ({ kind }) =>
    kind === "artifact" ? { ...base, kind } : destination,
  );
  render(
    <ReferencePickerComposer
      projectId={project_id}
      inputControlRef={{ current: control }}
      allowShareToConversation
      conversationTitle="Geometry discussion"
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Share artifact to conversation" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Share to conversation" }),
  ).toHaveTextContent("choose a destination human conversation");
  expect(screen.getByText(/does not publish a copy/)).toBeInTheDocument();
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Share @same: Shared work Artifact / Geometry / Unknown creator",
    }),
  );
  expect(mockListResources).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "artifact", limit: 25 }),
  );
  expect(control.insertText).not.toHaveBeenCalled();
  const search = await screen.findByRole("textbox", {
    name: "Search conversations",
  });
  await waitFor(() => expect(search).toHaveFocus());
  await userEvent.click(
    await screen.findByRole("button", {
      name: "@same: Other discussion Human conversation / Topology",
    }),
  );
  expect(screen.getByText(/all collaborators in Topology/)).toBeInTheDocument();
  expect(mockWriteDraft).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Add reference to draft" }),
  );
  await screen.findByRole("heading", { name: "Reference added to draft" });
  expect(mockWriteDraft).toHaveBeenCalledTimes(1);
  const opts = mockWriteDraft.mock.calls[0][0];
  const markup = opts.text;
  expect(parseCollaborationReference(markup.trim())?.target).toEqual({
    project_id,
    kind: "artifact",
    resource_id: "target-1",
  });
  expect(opts).toMatchObject({
    account_id: "viewer",
    project_id: destination.project_id,
    path: "/other.chat",
    append: true,
  });
  expect(control.insertText).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(control.focus).toHaveBeenCalled());
});

test.each(["account", "composer"])(
  "a changed %s cannot receive a late reference selection",
  async (changed) => {
    const control = {
      captureSelection: jest.fn(() => null),
      insertText: jest.fn(() => true),
      focus: jest.fn(),
    };
    const inputControlRef = { current: control };
    render(
      <ReferencePickerComposer
        projectId={project_id}
        inputControlRef={inputControlRef}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Insert reference" }),
    );
    const choice = await screen.findByRole("button", {
      name: /Shared work Agent/,
    });
    if (changed === "account") mockAccountId = "other";
    else inputControlRef.current = { ...control };
    await userEvent.click(choice);
    expect(control.insertText).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("conversation changed");
  },
);
