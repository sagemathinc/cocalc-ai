import { render, screen, waitFor } from "@testing-library/react";
import { VirtuosoMockContext, VirtuosoGridMockContext } from "react-virtuoso";
import { VirtualCollectionItems } from "./virtual-collection";

test.each(["list", "grid"] as const)(
  "%s renders a bounded virtual window",
  async (view) => {
    const items = Array.from({ length: 1000 }, (_, i) => String(i));
    const loadMore = jest.fn();
    render(
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 300, itemHeight: 60 }}
      >
        <VirtuosoGridMockContext.Provider
          value={{
            viewportHeight: 300,
            viewportWidth: 600,
            itemHeight: 60,
            itemWidth: 220,
          }}
        >
          <VirtualCollectionItems
            items={items}
            itemId={(item) => item}
            view={view}
            renderItem={(item) => <button>Item {item}</button>}
            loadMore={loadMore}
          />
        </VirtuosoGridMockContext.Provider>
      </VirtuosoMockContext.Provider>,
    );
    await screen.findByRole("button", { name: "Item 0", exact: true });
    await waitFor(() =>
      expect(screen.getAllByRole("button").length).toBeLessThan(50),
    );
    expect(
      screen.queryByRole("button", { name: "Item 999", exact: true }),
    ).toBeNull();
    expect(loadMore).not.toHaveBeenCalled();
  },
);
