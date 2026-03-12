/** @jest-environment jsdom */

import { List } from "immutable";
import { fireEvent, render, screen } from "@testing-library/react";
import FileTabs from "./file-tabs";

const mockActions = {
  close_tab: jest.fn(),
  focus_file_tab_strip: jest.fn(),
  move_file_tab: jest.fn(),
  set_file_tab_order: jest.fn(),
  set_active_tab: jest.fn(),
  show: jest.fn(),
};

let dragEnd: any;

jest.mock("antd", () => ({
  Tabs: ({ activeKey, items, onChange }: any) => (
    <div>
      {items.map((item: any) => (
        <div
          key={item.key}
          aria-selected={item.key === activeKey}
          onClick={() => onChange?.(item.key)}
          role="tab"
          tabIndex={0}
        >
          {item.label}
        </div>
      ))}
    </div>
  ),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => mockActions,
}));

jest.mock("@cocalc/frontend/components/sortable-tabs", () => ({
  SortableTabs: ({ children, onDragEnd }: any) => {
    dragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  renderTabBar: undefined,
  useItemContext: () => ({}),
  useSortable: () => ({ active: null }),
}));

const workspaces = {
  filterPaths: (paths: string[]) => [...paths],
  selection: { kind: "all" as const },
};

jest.mock("../context", () => ({
  useProjectContext: () => ({
    workspaces,
  }),
}));

jest.mock("./file-tab", () => ({
  FileTab: ({ label }: any) => <span>{label}</span>,
}));

describe("FileTabs keyboard navigation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.useFakeTimers();
    mockActions.close_tab.mockReset();
    mockActions.focus_file_tab_strip.mockReset();
    mockActions.move_file_tab.mockReset();
    mockActions.set_file_tab_order.mockReset();
    mockActions.set_active_tab.mockReset();
    mockActions.show.mockReset();
    dragEnd = undefined;
    workspaces.filterPaths = (paths: string[]) => [...paths];
    workspaces.selection = { kind: "all" };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("uses arrow keys on focused tabs to switch files without focusing the editor", () => {
    render(
      <FileTabs
        activeTab="editor-a.ts"
        openFiles={List(["a.ts", "b.ts"])}
        project_id="project-1"
      />,
    );

    const activeTab = screen.getAllByRole("tab")[0];
    fireEvent.keyDown(activeTab, { key: "ArrowRight" });
    jest.runAllTimers();

    expect(mockActions.set_active_tab).toHaveBeenCalledWith("editor-b.ts");
    expect(mockActions.focus_file_tab_strip).toHaveBeenCalled();
  });

  it("reorders only the visible workspace subset when dragging tabs", () => {
    workspaces.selection = { kind: "workspace", workspace_id: "w1" } as any;
    workspaces.filterPaths = (paths: string[]) =>
      paths.filter((path) => path.startsWith("a"));

    render(
      <FileTabs
        activeTab="editor-a1.ts"
        openFiles={List(["a1.ts", "b1.ts", "a2.ts", "c1.ts", "a3.ts"])}
        project_id="project-1"
      />,
    );

    expect(typeof dragEnd).toBe("function");
    dragEnd({
      active: { id: "a3.ts" },
      over: { id: "a1.ts" },
    });

    expect(mockActions.set_file_tab_order).toHaveBeenCalledWith([
      "a3.ts",
      "b1.ts",
      "a1.ts",
      "c1.ts",
      "a2.ts",
    ]);
    expect(mockActions.move_file_tab).not.toHaveBeenCalled();
  });
});
