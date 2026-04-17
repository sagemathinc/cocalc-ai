import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

import { getSharedAccountDkv } from "@cocalc/frontend/conat/account-dkv";
import { useNavigationHistory } from "./use-navigation-history";
import { waitForPersistAccountId } from "./persist-account-id";

jest.mock("./persist-account-id", () => ({
  waitForPersistAccountId: jest.fn(),
}));

jest.mock("@cocalc/frontend/conat/account-dkv", () => ({
  getSharedAccountDkv: jest.fn(),
}));

class FakeNavDkv {
  private readonly values = new Map<
    string,
    { history: string[]; cursor: number }
  >();

  get(key: string) {
    return this.values.get(key);
  }

  set(key: string, value: { history: string[]; cursor: number }) {
    this.values.set(key, value);
  }
}

function TestComponent() {
  const [currentPath, setCurrentPath] = useState("/alpha");
  const nav = useNavigationHistory(
    "project-1",
    currentPath,
    (path) => setCurrentPath(path),
    "explorer",
  );

  return (
    <>
      <span data-testid="path">{currentPath}</span>
      <span data-testid="can-forward">{nav.canGoForward ? "yes" : "no"}</span>
      <button
        onClick={() => {
          const next = "/beta";
          setCurrentPath(next);
          nav.recordNavigation(next);
        }}
      >
        visit-beta
      </button>
      <button onClick={nav.goBack}>back</button>
      <button onClick={nav.goForward}>forward</button>
    </>
  );
}

describe("useNavigationHistory", () => {
  const waitForPersistAccountIdMock = waitForPersistAccountId as jest.Mock;
  const dkvMock = getSharedAccountDkv as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    waitForPersistAccountIdMock.mockResolvedValue("account-1");
    dkvMock.mockResolvedValue(new FakeNavDkv());
  });

  it("keeps forward navigation enabled after going back", async () => {
    render(<TestComponent />);

    await waitFor(() => {
      expect(dkvMock).toHaveBeenCalledWith({
        account_id: "account-1",
        name: "explorer-nav-history",
      });
    });

    fireEvent.click(screen.getByText("visit-beta"));
    expect(screen.getByTestId("path").textContent).toBe("/beta");

    fireEvent.click(screen.getByText("back"));
    expect(screen.getByTestId("path").textContent).toBe("/alpha");

    await waitFor(() => {
      expect(screen.getByTestId("can-forward").textContent).toBe("yes");
    });

    fireEvent.click(screen.getByText("forward"));
    expect(screen.getByTestId("path").textContent).toBe("/beta");
  });
});
