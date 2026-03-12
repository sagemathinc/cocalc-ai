import { EventEmitter } from "events";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useBookmarkedProjects } from "./use-bookmarked-projects";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      dkv: jest.fn(),
    },
  },
}));

class FakeBookmarks extends EventEmitter {
  constructor(private readonly values: Record<string, string[]>) {
    super();
  }

  get(key: string) {
    return this.values[key];
  }

  set = jest.fn((key: string, value: string[]) => {
    this.values[key] = value;
  });

  setMaxListeners(n: number) {
    super.setMaxListeners(n);
    return this;
  }
}

function TestComponent() {
  const { bookmarkedProjects, isInitialized, setProjectBookmarked } =
    useBookmarkedProjects();
  return (
    <div>
      <button onClick={() => setProjectBookmarked("project-1", true)}>
        add-1
      </button>
      <button onClick={() => setProjectBookmarked("project-2", true)}>
        add-2
      </button>
      <span data-testid="ready">{isInitialized ? "yes" : "no"}</span>
      <span data-testid="bookmarks">{bookmarkedProjects.join(",")}</span>
    </div>
  );
}

describe("useBookmarkedProjects", () => {
  const getStoreMock = redux.getStore as jest.Mock;
  const dkvMock = webapp_client.conat_client.dkv as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    getStoreMock.mockReturnValue({
      async_wait: async () => {},
      get_account_id: () => "account-1",
    });
  });

  it("preserves both rapid bookmark additions", async () => {
    const bookmarks = new FakeBookmarks({
      projects: [],
    });
    dkvMock.mockResolvedValue(bookmarks);

    render(<TestComponent />);

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("yes");
    });

    await act(async () => {
      fireEvent.click(screen.getByText("add-1"));
      fireEvent.click(screen.getByText("add-2"));
    });

    expect(screen.getByTestId("bookmarks").textContent).toBe(
      "project-2,project-1",
    );
    expect(bookmarks.set).toHaveBeenNthCalledWith(1, "projects", ["project-1"]);
    expect(bookmarks.set).toHaveBeenNthCalledWith(2, "projects", [
      "project-2",
      "project-1",
    ]);
  });
});
