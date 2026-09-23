import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibraryEntry } from "./library-entry";

const getEntry = jest.fn();
const view = jest.fn();
let artifactNames: any[] = [];
jest.mock("./artifact-names", () => ({
  useArtifactNames: () => ({ names: artifactNames, setName: jest.fn() }),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { artifactCatalog: { getEntry: (opts) => getEntry(opts) } },
    },
  },
}));
jest.mock("./library-artifact-view", () => ({
  LibraryArtifactView: (props) => {
    view(props);
    return (
      <div>
        <span>{props.target.artifactId}</span>
        <button onClick={props.onBack}>Back to Library</button>
        <button onClick={props.onShowConversation}>
          Open source conversation
        </button>
      </div>
    );
  },
}));

const entry = {
  project_id: "project",
  entry_id: "entry",
  chat_path: "/source.chat",
  item: {
    thread_id: "thread",
    artifact_id: "artifact",
    publication: { operation_id: "old-publication" },
  },
};
const props = {
  accountId: "account",
  projectId: "project",
  entryId: "entry",
  agents: [],
  onBack: jest.fn(),
  onShowConversation: jest.fn(),
};
beforeEach(() => {
  jest.clearAllMocks();
  artifactNames = [];
  getEntry.mockResolvedValue(entry);
});

test("personal short URL resolves through the same authorized catalog lookup", async () => {
  artifactNames = [
    { name: "nb1", project_id: "project", entry_id: "entry", active: true },
  ];
  render(<LibraryEntry {...props} projectId="nb1" entryId="" />);
  await screen.findByText("artifact");
  expect(getEntry).toHaveBeenCalledWith({
    project_id: "project",
    entry_id: "entry",
  });
  expect(view.mock.calls.at(-1)[0].artifactName).toBe("nb1");
});

test("direct links resolve without an agent; source navigation is explicit", async () => {
  const user = userEvent.setup();
  render(<LibraryEntry {...props} />);
  await screen.findByText("artifact");
  expect(getEntry).toHaveBeenCalledWith({
    project_id: "project",
    entry_id: "entry",
  });
  const target = view.mock.calls.at(-1)[0].target;
  expect(target).toEqual({
    projectId: "project",
    path: "/source.chat",
    threadId: "thread",
    artifactId: "artifact",
    agentId: undefined,
  });
  expect(target.publicationId).toBeUndefined();
  expect(props.onShowConversation).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Open source conversation" }),
  );
  expect(props.onShowConversation).toHaveBeenCalledWith(target);
  await user.click(screen.getByRole("button", { name: "Back to Library" }));
  expect(props.onBack).toHaveBeenCalled();
});

test("account and route changes discard stale content and late responses", async () => {
  let resolve: (value: unknown) => void = () => {};
  getEntry.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const rendered = render(<LibraryEntry {...props} />);
  getEntry.mockRejectedValueOnce(Error("Access denied"));
  rendered.rerender(<LibraryEntry {...props} accountId="other-account" />);
  await screen.findByRole("alert");
  await act(async () => resolve(entry));
  expect(screen.queryByText("artifact")).toBeNull();
  expect(view).not.toHaveBeenCalled();
});

test("missing and mismatched entries fail closed, with keyboard retry", async () => {
  getEntry.mockResolvedValueOnce(null);
  const user = userEvent.setup();
  render(<LibraryEntry {...props} />);
  await screen.findByRole("alert");
  expect(view).not.toHaveBeenCalled();
  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Retry" }),
  );
  getEntry.mockResolvedValueOnce({ ...entry, project_id: "wrong-project" });
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "different artifact",
    ),
  );
  expect(view).not.toHaveBeenCalled();
});
