import { Map, fromJS } from "immutable";
import type { AppRedux } from "@cocalc/util/redux/types";
import { TextEditorActions } from "../actions-text";

function makeRedux(): AppRedux {
  return {
    getStore: jest.fn(),
    _set_state: jest.fn(),
    removeActions: jest.fn(),
  } as unknown as AppRedux;
}

class NavigationHarness extends TextEditorActions {
  private state: Map<string, any>;
  public focusedIds: string[] = [];

  constructor(tree: any, activeId: string) {
    super("navigation-harness", makeRedux());
    this.state = Map({
      local_view_state: Map({
        active_id: activeId,
        frame_tree: fromJS(tree),
      }),
    });
    this.store = this.state as any;
    (this as any)._save_local_view_state = jest.fn();
    (this as any).setState = (obj: any) => {
      this.state = this.state.merge(obj);
      this.store = this.state as any;
    };
  }

  override focus(id?: string): void {
    this.focusedIds.push(id ?? this.get_active_frame_id() ?? "");
  }
}

describe("Base editor frame navigation", () => {
  const splitTree = {
    direction: "row",
    id: "root",
    type: "node",
    first: { id: "frame-a", type: "cm" },
    second: { id: "frame-b", type: "terminal" },
  };

  it("returns frame ids in tree order", () => {
    const actions = new NavigationHarness(splitTree, "frame-a");

    expect(actions.get_frame_ids_in_order()).toEqual(["frame-a", "frame-b"]);
  });

  it("focuses the next frame and updates the active id", () => {
    const actions = new NavigationHarness(splitTree, "frame-a");

    expect(actions.focus_next_frame()).toBe(true);
    expect(actions.get_active_frame_id()).toBe("frame-b");
    expect(actions.focusedIds).toContain("frame-b");
  });

  it("focuses the previous frame and wraps backwards", () => {
    const actions = new NavigationHarness(splitTree, "frame-a");

    expect(actions.focus_previous_frame()).toBe(true);
    expect(actions.get_active_frame_id()).toBe("frame-b");
    expect(actions.focusedIds).toContain("frame-b");
  });

  it("returns false instead of wrapping past the final frame", () => {
    const actions = new NavigationHarness(splitTree, "frame-b");

    expect(actions.focus_next_frame_without_wrap()).toBe(false);
    expect(actions.get_active_frame_id()).toBe("frame-b");
  });

  it("moves to the previous sibling without wrapping when available", () => {
    const actions = new NavigationHarness(splitTree, "frame-b");

    expect(actions.focus_previous_frame_without_wrap()).toBe(true);
    expect(actions.get_active_frame_id()).toBe("frame-a");
    expect(actions.focusedIds).toContain("frame-a");
  });

  it("does not claim success when there is only one frame", () => {
    const actions = new NavigationHarness({ id: "solo", type: "cm" }, "solo");

    expect(actions.focus_next_frame()).toBe(false);
    expect(actions.focus_previous_frame()).toBe(false);
    expect(actions.focusedIds).toHaveLength(0);
  });
});
