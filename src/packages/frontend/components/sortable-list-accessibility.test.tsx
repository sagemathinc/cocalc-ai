import { render, screen } from "@testing-library/react";
import { SortableList, SortableItem } from "./sortable-list";

test("drag announcements remain outside semantic lists", () => {
  render(
    <div role="list" aria-label="Items">
      <SortableList items={["one"]}>
        <SortableItem id="one">
          <div role="listitem">One</div>
        </SortableItem>
      </SortableList>
    </div>,
  );
  const list = screen.getByRole("list", { name: "Items" });
  expect(list.contains(screen.getByRole("status"))).toBe(false);
  expect(list.contains(screen.getByRole("listitem"))).toBe(true);
});
