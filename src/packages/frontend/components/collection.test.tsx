import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Collection } from "./collection";
import { moveVisibleCollectionPin } from "./collection-order";

test("grid drag keyboard navigation moves horizontally, not only vertically", async () => {
  const user = userEvent.setup();
  const move = jest.fn();
  const geometry = jest
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const row =
        this.querySelector("[data-test-item]") ??
        this.closest("[data-test-item]");
      const index = Number(row?.getAttribute("data-test-item") ?? 0);
      const x = (index % 2) * 200;
      const y = Math.floor(index / 2) * 100;
      return {
        x,
        y,
        left: x,
        top: y,
        right: x + 180,
        bottom: y + 80,
        width: 180,
        height: 80,
        toJSON: () => ({}),
      };
    });
  try {
    render(
      <Collection
        items={["0", "1", "2", "3"]}
        itemId={(id) => id}
        itemTitle={(id) => id}
        pins={["0", "1", "2", "3"]}
        view="grid"
        otherTitle="Other things"
        onMove={move}
        renderItem={(id, controls) => (
          <div data-test-item={id}>{controls.dragHandle}</div>
        )}
      />,
    );
    act(() =>
      screen.getByRole("button", { name: "Drag 0 to reorder" }).focus(),
    );
    await user.keyboard(" ");
    await user.keyboard("{ArrowRight}");
    await user.keyboard(" ");
    expect(move).toHaveBeenCalledWith(["0", "1", "2", "3"], "0", 1);
  } finally {
    geometry.mockRestore();
  }
});

test("moving visible pins preserves hidden slots and ignores invalid moves", () => {
  const pins = ["hidden", "a", "filtered", "b", "c"];
  expect(moveVisibleCollectionPin(pins, ["a", "b"], "a", 1)).toEqual([
    "hidden",
    "b",
    "filtered",
    "a",
    "c",
  ]);
  expect(moveVisibleCollectionPin(pins, ["a", "b"], "missing", 1)).toBe(pins);
  expect(moveVisibleCollectionPin(pins, ["a", "b"], "a", -1)).toBe(pins);
});

test.each(["list", "grid"] as const)(
  "%s offers the same pin, keyboard reorder and focus behavior",
  async (view) => {
    const user = userEvent.setup();
    function Example() {
      const [pins, setPins] = useState(["a", "b"]);
      return (
        <Collection
          items={["c", "b", "a"]}
          itemId={(id) => id}
          itemTitle={(id) => id}
          view={view}
          pins={pins}
          otherTitle="Other things"
          onPin={(id, pinned) =>
            setPins(
              pinned ? [...pins, id] : pins.filter((value) => value !== id),
            )
          }
          onMove={(visible, id, index) =>
            setPins(moveVisibleCollectionPin(pins, visible, id, index))
          }
          renderItem={(id, controls) => (
            <div>
              <button>Open {id}</button>
              {controls.dragHandle}
              {controls.pinButton}
              {controls.orderMenu}
            </div>
          )}
        />
      );
    }
    render(<Example />);
    const pinned = () => within(screen.getByRole("region", { name: "Pinned" }));
    expect(
      pinned()
        .getAllByRole("listitem")
        .map(
          (item) =>
            within(item).getByRole("button", { name: /^Open/ }).textContent,
        ),
    ).toEqual(["Open a", "Open b"]);
    const trigger = screen.getByRole("button", { name: "Reorder a" });
    act(() => trigger.focus());
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const down = screen.getByRole("menuitem", { name: "Move down" });
    act(() => down.focus());
    fireEvent.keyDown(down, { key: "Enter", keyCode: 13 });
    expect(trigger).toHaveFocus();
    expect(
      pinned()
        .getAllByRole("listitem")
        .map(
          (item) =>
            within(item).getByRole("button", { name: /^Open/ }).textContent,
        ),
    ).toEqual(["Open b", "Open a"]);
    const pin = screen.getByRole("button", { name: "Pin c" });
    act(() => pin.focus());
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Unpin c" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Pin c" })).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Drag a to reorder" }),
    ).toHaveAttribute("tabindex", "0");
    if (view === "grid")
      expect(pinned().getByRole("list")).toHaveStyle({ display: "grid" });
  },
);
