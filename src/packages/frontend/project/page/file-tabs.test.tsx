/** @jest-environment jsdom */

import { List } from "immutable";
import { fireEvent, render, screen } from "@testing-library/react";
import FileTabs from "./file-tabs";

const mockActions = {
  close_tab: jest.fn(),
  focus_file_tab_strip: jest.fn(),
  move_file_tab: jest.fn(),
  set_active_tab: jest.fn(),
  show: jest.fn(),
};

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
  SortableTabs: ({ children }: any) => <div>{children}</div>,
  renderTabBar: undefined,
  useItemContext: () => ({}),
  useSortable: () => ({ active: null }),
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
    mockActions.set_active_tab.mockReset();
    mockActions.show.mockReset();
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
});
