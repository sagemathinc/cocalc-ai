/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { AccessibleAddTabIcon, SortableTab } from "./sortable-tabs";

const mockPointerDown = jest.fn();

jest.mock("@dnd-kit/sortable", () => ({
  horizontalListSortingStrategy: {},
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  useSortable: () => ({
    active: null,
    attributes: {
      "aria-describedby": "drag-instructions",
      "aria-roledescription": "sortable",
      role: "button",
      tabIndex: 0,
    },
    listeners: { onPointerDown: mockPointerDown },
    setNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
  }),
}));

describe("SortableTab", () => {
  beforeEach(() => {
    mockPointerDown.mockClear();
  });

  it("keeps drag listeners without overriding the tab's ARIA semantics", () => {
    render(
      <SortableTab id="a">
        <div aria-selected="false" role="tab">
          Alpha
        </div>
      </SortableTab>,
    );

    const tab = screen.getByRole("tab", { name: "Alpha" });
    const wrapper = tab.parentElement;

    expect(wrapper).not.toHaveAttribute("role");
    expect(wrapper).not.toHaveAttribute("tabindex");
    expect(wrapper).not.toHaveAttribute("aria-roledescription");

    fireEvent.pointerDown(wrapper!);
    expect(mockPointerDown).toHaveBeenCalled();
  });
});

describe("AccessibleAddTabIcon", () => {
  it("gives Ant's native add button valid tablist semantics", () => {
    render(
      <button className="ant-tabs-nav-add">
        <AccessibleAddTabIcon label="Create file">+</AccessibleAddTabIcon>
      </button>,
    );

    const button = screen.getByRole("tab", { name: "Create file" });
    expect(button).toHaveAttribute("aria-selected", "false");
  });
});
