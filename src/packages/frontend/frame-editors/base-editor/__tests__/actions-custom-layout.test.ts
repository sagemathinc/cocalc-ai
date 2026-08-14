import { BaseEditorActions } from "../actions-base";
import { loadCustomLayout } from "../../frame-tree/frame-editor-settings";

jest.mock("../../frame-tree/frame-editor-settings", () => ({
  hasCustomLayout: jest.fn(),
  loadCustomLayout: jest.fn(),
  saveCustomLayout: jest.fn(),
}));

const loadCustomLayoutMock = loadCustomLayout as jest.MockedFunction<
  typeof loadCustomLayout
>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("BaseEditorActions custom layout loading", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("applies a saved layout when the frame tree stayed unchanged", async () => {
    const layout = { type: "cm" } as const;
    loadCustomLayoutMock.mockResolvedValue(layout);
    const target: any = {
      _frame_tree_revision: 0,
      path: "test.py",
      replace_frame_tree: jest.fn(),
      setState: jest.fn(),
    };

    await BaseEditorActions.prototype["_apply_custom_layout_if_available"].call(
      target,
    );

    expect(target.setState).toHaveBeenCalledWith({ has_custom_layout: true });
    expect(target.replace_frame_tree).toHaveBeenCalledWith(layout);
  });

  it("preserves frame edits made while the saved layout is loading", async () => {
    const pending = deferred<{ type: string } | null>();
    loadCustomLayoutMock.mockReturnValue(pending.promise);
    const target: any = {
      _frame_tree_revision: 0,
      path: "test.py",
      replace_frame_tree: jest.fn(),
      setState: jest.fn(),
    };

    const loading =
      BaseEditorActions.prototype["_apply_custom_layout_if_available"].call(
        target,
      );
    target._frame_tree_revision += 1;
    pending.resolve({ type: "cm" });
    await loading;

    expect(target.setState).toHaveBeenCalledWith({ has_custom_layout: true });
    expect(target.replace_frame_tree).not.toHaveBeenCalled();
  });
});
