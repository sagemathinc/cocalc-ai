import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Collection, CollectionViewControl } from "./collection";
import type { CollectionView } from "./collection";
import { moveVisibleCollectionPin } from "./collection-order";

test("layout switches keep the focused button mounted", async () => {
  const user = userEvent.setup();
  function Example() {
    const [view, setView] = useState<CollectionView>("list");
    return (
      <CollectionViewControl label="Items" view={view} onChange={setView} />
    );
  }
  render(<Example />);
  for (const name of ["Grid view", "List view"]) {
    const button = screen.getByRole("button", { name });
    act(() => button.focus());
    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveFocus();
    expect(screen.getByRole("button", { name })).toBe(button);
  }
});

test.each(["list", "grid"] as const)(
  "%s supports keyboard drag ordering",
  async (view) => {
    const user = userEvent.setup();
    const move = jest.fn();
    const geometry = jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const row =
          this.querySelector("[data-test-item]") ??
          this.closest("[data-test-item]");
        const index = Number(row?.getAttribute("data-test-item") ?? 0);
        const x = view === "grid" ? (index % 2) * 200 : 0;
        const y = (view === "grid" ? Math.floor(index / 2) : index) * 100;
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
          view={view}
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
      await user.keyboard(view === "grid" ? "{ArrowRight}" : "{ArrowDown}");
      await user.keyboard(" ");
      expect(move).toHaveBeenCalledWith(["0", "1", "2", "3"], "0", 1);
    } finally {
      geometry.mockRestore();
    }
  },
);

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
  "%s offers the same pin, action menu and focus behavior without move menus",
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
              {controls.menu(
                [{ key: "open", label: "Open item", onClick: () => {} }],
                `Options for ${id}`,
              )}
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
    const trigger = screen.getByRole("button", { name: "Options for a" });
    act(() => trigger.focus());
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("menuitem", { name: /Move up|Move down/ }),
    ).toBeNull();
    const action = screen.getByRole("menuitem", { name: "Open item" });
    act(() => action.focus());
    fireEvent.keyDown(action, { key: "Enter", keyCode: 13 });
    expect(trigger).toHaveFocus();
    expect(
      pinned()
        .getAllByRole("listitem")
        .map(
          (item) =>
            within(item).getByRole("button", { name: /^Open/ }).textContent,
        ),
    ).toEqual(["Open a", "Open b"]);
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
