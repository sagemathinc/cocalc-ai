import { EventEmitter } from "events";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useStarredFilesManager } from "./store";
import { redux } from "@cocalc/frontend/app-framework";
import { getSharedAccountDkv } from "@cocalc/frontend/conat/account-dkv";
import { waitForPersistAccountId } from "@cocalc/frontend/project/explorer/persist-account-id";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/conat/account-dkv", () => ({
  getSharedAccountDkv: jest.fn(),
}));

jest.mock("@cocalc/frontend/project/explorer/persist-account-id", () => ({
  waitForPersistAccountId: jest.fn(),
}));

class FakeBookmarks extends EventEmitter {
  constructor(private readonly values: Record<string, string[]>) {
    super();
  }

  get(key: string) {
    return this.values[key];
  }

  setMaxListeners(n: number) {
    super.setMaxListeners(n);
    return this;
  }
}

function TestComponent({
  project_id,
  enabled = true,
}: {
  project_id: string;
  enabled?: boolean;
}) {
  const { starred } = useStarredFilesManager(project_id, enabled);
  return <span data-testid="starred">{starred.join(",")}</span>;
}

describe("useStarredFilesManager", () => {
  const getStoreMock = redux.getStore as jest.Mock;
  const dkvMock = getSharedAccountDkv as jest.Mock;
  const waitForPersistAccountIdMock = waitForPersistAccountId as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    getStoreMock.mockReturnValue({
      async_wait: async () => {},
      get_account_id: () => "account-1",
    });
    waitForPersistAccountIdMock.mockResolvedValue("account-1");
  });

  it("drops the old project listener when switching projects", async () => {
    const bookmarks = new FakeBookmarks({
      "project-1": ["alpha.md"],
      "project-2": ["beta.md"],
    });
    dkvMock.mockResolvedValue(bookmarks);

    const { rerender } = render(<TestComponent project_id="project-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("starred").textContent).toBe("alpha.md");
    });

    rerender(<TestComponent project_id="project-2" />);

    await waitFor(() => {
      expect(screen.getByTestId("starred").textContent).toBe("beta.md");
    });

    await act(async () => {
      bookmarks.emit("change", { key: "project-1", value: ["stale.md"] });
    });
    expect(screen.getByTestId("starred").textContent).toBe("beta.md");

    await act(async () => {
      bookmarks.emit("change", { key: "project-2", value: ["gamma.md"] });
    });
    expect(screen.getByTestId("starred").textContent).toBe("gamma.md");
  });

  it("does not initialize bookmarks after unmounting before auth resolves", async () => {
    let resolveAccountId!: (value: string) => void;
    waitForPersistAccountIdMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAccountId = resolve;
      }),
    );

    const { unmount } = render(<TestComponent project_id="project-1" />);
    unmount();

    await act(async () => {
      resolveAccountId("account-1");
      await Promise.resolve();
    });

    expect(dkvMock).not.toHaveBeenCalled();
  });
});
