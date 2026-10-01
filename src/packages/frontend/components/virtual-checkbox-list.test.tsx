import { render, screen, waitFor } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { VirtualCheckboxList } from "./virtual-checkbox-list";

test("large selectors mount only a virtual window", async () => {
  render(
    <VirtuosoMockContext.Provider
      value={{ viewportHeight: 288, itemHeight: 44 }}
    >
      <VirtualCheckboxList
        items={Array.from({ length: 1000 }, (_, i) => `Project ${i}`)}
        itemId={(item) => item}
        itemLabel={(item) => item}
        selected={[]}
        onChange={() => {}}
        label="Projects"
      />
    </VirtuosoMockContext.Provider>,
  );
  await screen.findByRole("checkbox", { name: "Project 0", exact: true });
  await waitFor(() =>
    expect(screen.getAllByRole("checkbox").length).toBeLessThan(25),
  );
  expect(
    screen.queryByRole("checkbox", { name: "Project 999", exact: true }),
  ).toBeNull();
});
