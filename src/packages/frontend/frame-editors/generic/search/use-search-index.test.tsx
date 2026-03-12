import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import useSearchIndex, { SearchIndex } from "./use-search-index";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { create, insertMultiple } from "@orama/orama";

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: jest.fn(),
}));

jest.mock("@orama/orama", () => ({
  create: jest.fn(),
  insertMultiple: jest.fn(),
  search: jest.fn(),
}));

function TestComponent() {
  const { index, doRefresh } = useSearchIndex();
  return (
    <div>
      <button onClick={() => doRefresh()}>refresh</button>
      <span data-testid="index-state">{index == null ? "empty" : "ready"}</span>
    </div>
  );
}

describe("useSearchIndex", () => {
  const useFrameContextMock = useFrameContext as jest.Mock;
  const createMock = create as jest.Mock;
  const insertMultipleMock = insertMultiple as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    createMock.mockResolvedValue({});
    insertMultipleMock.mockResolvedValue(undefined);
    useFrameContextMock.mockReturnValue({
      actions: {
        getSearchIndexData: () => ({
          data: { a: "alpha" },
          fragmentKey: "id",
          reduxName: "test-redux",
        }),
      },
      project_id: "project-1",
      path: "file.chat",
    });
  });

  it("closes replaced indexes on refresh and closes the active index on unmount", async () => {
    const closeSpy = jest.spyOn(SearchIndex.prototype, "close");
    const { unmount } = render(<TestComponent />);

    await waitFor(() => {
      expect(screen.getByTestId("index-state").textContent).toBe("ready");
    });

    fireEvent.click(screen.getByText("refresh"));

    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("index-state").textContent).toBe("ready");
    });

    unmount();

    expect(closeSpy).toHaveBeenCalledTimes(2);
  });
});
