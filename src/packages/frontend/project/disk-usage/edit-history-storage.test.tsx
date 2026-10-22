import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import EditHistoryStorage from "./edit-history-storage";

const listProjectPersistStorage = jest.fn();
const applyProjectPersistStorage = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        projects: {
          listProjectPersistStorage: (...args: any[]) =>
            listProjectPersistStorage(...args),
          applyProjectPersistStorage: (...args: any[]) =>
            applyProjectPersistStorage(...args),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (action: () => Promise<void>) => {
      await action();
      return true;
    },
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: () => <span>ago</span>,
}));

const PROJECT = "11111111-2222-4333-8444-555555555555";
const MiB = 1024 * 1024;

function listing(can_manage: boolean) {
  return {
    supported: true,
    can_manage,
    total: { count: 3, bytes: 30 * MiB },
    by_kind: {
      "agent-log": { count: 1, bytes: 20 * MiB },
      "edit-history": { count: 2, bytes: 10 * MiB },
    },
    streams: [
      {
        name: "acp-log/home/user/a.chat",
        kind: "agent-log",
        document: "/home/user/a.chat",
        document_exists: true,
        bytes: 20 * MiB,
        reclaimable: 0,
        modified: Date.now(),
      },
      {
        name: "patchflow/home/user/gone.md",
        kind: "edit-history",
        document: "/home/user/gone.md",
        document_exists: false,
        bytes: 6 * MiB,
        reclaimable: 0,
        modified: Date.now(),
      },
      {
        name: "patchflow/home/user/a.md",
        kind: "edit-history",
        document: "/home/user/a.md",
        document_exists: true,
        bytes: 4 * MiB,
        reclaimable: 0,
        modified: Date.now(),
      },
    ],
  };
}

beforeEach(() => {
  listProjectPersistStorage.mockReset();
  applyProjectPersistStorage.mockReset();
  applyProjectPersistStorage.mockResolvedValue({
    freed: 5 * MiB,
    results: [{ name: "x", op: "trim", ok: true, freed: 5 * MiB }],
  });
});

describe("EditHistoryStorage", () => {
  it("shows what the history and logs take, and trims a log", async () => {
    listProjectPersistStorage.mockResolvedValue(listing(true));
    render(<EditHistoryStorage project_id={PROJECT} />);
    expect(await screen.findByText("/home/user/a.chat")).toBeTruthy();
    expect(screen.getByText("file deleted")).toBeTruthy();
    expect(screen.getByText(/in 3 streams/)).toBeTruthy();
    expect(listProjectPersistStorage).toHaveBeenCalledWith({
      project_id: PROJECT,
      limit: 2000,
    });
    fireEvent.click(screen.getByText("Keep last 30 days"));
    await waitFor(() =>
      expect(applyProjectPersistStorage).toHaveBeenCalledWith({
        browser_id: "browser-1",
        project_id: PROJECT,
        actions: [
          {
            op: "trim",
            name: "acp-log/home/user/a.chat",
            before: expect.any(Number),
          },
        ],
      }),
    );
    expect(await screen.findByText(/^Freed /)).toBeTruthy();
  });

  it("cleans up the history of deleted files and old logs", async () => {
    listProjectPersistStorage.mockResolvedValue(listing(true));
    render(<EditHistoryStorage project_id={PROJECT} />);
    await screen.findByText("/home/user/a.chat");
    fireEvent.click(screen.getByText("Clean up…"));
    fireEvent.click(await screen.findByRole("button", { name: "Clean up" }));
    await waitFor(() => expect(applyProjectPersistStorage).toHaveBeenCalled());
    expect(applyProjectPersistStorage.mock.calls[0][0].actions).toEqual([
      { op: "delete", name: "patchflow/home/user/gone.md" },
      {
        op: "trim",
        name: "acp-log/home/user/a.chat",
        before: expect.any(Number),
      },
    ]);
  });

  it("lets only those who may manage it delete or trim", async () => {
    listProjectPersistStorage.mockResolvedValue(listing(false));
    render(<EditHistoryStorage project_id={PROJECT} />);
    await screen.findByText("/home/user/a.chat");
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByText("Clean up…")).toBeNull();
    expect(
      screen.getByText(/Only owners can delete or trim them/),
    ).toBeTruthy();
  });

  it("shows nothing while the history is in the project's files", async () => {
    listProjectPersistStorage.mockResolvedValue({
      ...listing(true),
      supported: false,
    });
    const { container } = render(<EditHistoryStorage project_id={PROJECT} />);
    await waitFor(() => expect(listProjectPersistStorage).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
