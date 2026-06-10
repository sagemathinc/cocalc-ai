import type { AppRedux } from "@cocalc/util/redux/types";
import type { PatchId } from "@cocalc/sync";
import type { SyncString } from "@cocalc/sync/editor/string/sync";
import { fromJS, Map } from "immutable";
import { TextEditorActions } from "../actions-text";
import { StructuredEditorActions } from "../actions-structured";
import { MergeCoordinator } from "../../code-editor/sync";

class TestMergeCoordinator extends MergeCoordinator {
  constructor(private seedCalls: Array<{ value: string; version?: PatchId }>) {
    super({ getLocal: () => "local", applyMerged: () => {} });
  }

  override seedBase(value: string, version?: PatchId): void {
    this.seedCalls.push({ value, version });
    super.seedBase(value, version);
  }
}

class TestTextActions extends TextEditorActions {
  public seedCalls: Array<{ value: string; version?: PatchId }> = [];

  public setDoctype(value: string): void {
    this.doctype = value;
  }

  public setSyncString(sync: SyncString): void {
    this._syncstring = sync;
  }

  public runInitSyncStringValue(): void {
    this._init_syncstring_value();
  }

  public hasSyncAdapter(): boolean {
    return this.syncAdapter != null;
  }

  protected getMergeCoordinator(): MergeCoordinator {
    return new TestMergeCoordinator(this.seedCalls);
  }

  protected getLatestVersion(): PatchId | undefined {
    return "1_abcd" as PatchId;
  }
}

class TestStructuredActions extends StructuredEditorActions {
  public setSyncString(sync: SyncString): void {
    this._syncstring = sync;
  }

  public runInitSyncStringValue(): void {
    this._init_syncstring_value();
  }
}

function makeRedux(): AppRedux {
  return {
    getStore: jest.fn(),
    _set_state: jest.fn(),
    removeActions: jest.fn(),
  } as unknown as AppRedux;
}

function makeSyncStub() {
  return {
    to_str: jest.fn().mockReturnValue("hello"),
    on: jest.fn(),
    off: jest.fn(),
  };
}

describe("Base editor action structure", () => {
  it("TextEditorActions uses to_str and wires SyncAdapter for syncstring", () => {
    const redux = makeRedux();
    const actions = new TestTextActions("test-text", redux);
    const sync = makeSyncStub();

    actions.setSyncString(sync as unknown as SyncString);
    actions.setDoctype("syncstring");
    actions.runInitSyncStringValue();

    expect(sync.to_str).toHaveBeenCalled();
    expect(actions.seedCalls).toHaveLength(1);
    expect(actions.hasSyncAdapter()).toBe(true);
    expect(sync.on).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("TextEditorActions skips SyncAdapter for non-syncstring doctypes", () => {
    const redux = makeRedux();
    const actions = new TestTextActions("test-text", redux);
    const sync = makeSyncStub();

    actions.setSyncString(sync as unknown as SyncString);
    actions.setDoctype("syncdb");
    actions.runInitSyncStringValue();

    expect(sync.to_str).toHaveBeenCalled();
    expect(actions.hasSyncAdapter()).toBe(false);
  });

  it("TextEditorActions flushes the most recent CodeMirror when saving without an explicit frame id", () => {
    const staleCm = { getValue: jest.fn(() => "stale source") };
    const freshCm = { getValue: jest.fn(() => "fresh source") };
    const sync = {
      get_state: jest.fn(() => "ready"),
      exit_undo_mode: jest.fn(),
      to_str: jest.fn(() => "old source"),
      from_str: jest.fn(),
      commit: jest.fn(),
      save: jest.fn(),
      emit: jest.fn(),
    };
    const actions: any = Object.create(TextEditorActions.prototype);
    actions._state = undefined;
    actions._syncstring = sync;
    actions._get_cm = jest.fn((id?: string, recent?: boolean) =>
      id == null && recent ? freshCm : staleCm,
    );

    actions.set_syncstring_to_codemirror(undefined, true);

    expect(actions._get_cm).toHaveBeenCalledWith(undefined, true);
    expect(staleCm.getValue).not.toHaveBeenCalled();
    expect(freshCm.getValue).toHaveBeenCalled();
    expect(sync.from_str).toHaveBeenCalledWith("fresh source");
    expect(sync.emit).toHaveBeenCalledWith("change", {
      local: true,
      source: "cm",
    });
  });

  it("synchronously persists frame tree deletes before refresh can restore stale splits", () => {
    const actions: any = Object.create(TextEditorActions.prototype);
    const localViewState = Map({
      frame_tree: fromJS({
        type: "node",
        id: "root",
        direction: "row",
        children: [
          { type: "slate", id: "slate-frame" },
          { type: "cm", id: "cm-frame" },
        ],
        sizes: [0.5, 0.5],
      }),
      full_id: "cm-frame",
    });
    actions.store = {
      get: jest.fn((key) =>
        key === "local_view_state" ? localViewState : undefined,
      ),
    };
    actions.setState = jest.fn();
    actions._save_local_view_state = jest.fn();
    actions._save_local_view_state_value = jest.fn();

    actions._tree_op("delete_node", "cm-frame");

    const nextLocal = actions.setState.mock.calls[0][0].local_view_state;
    expect(nextLocal.getIn(["frame_tree", "type"])).toBe("slate");
    expect(nextLocal.getIn(["frame_tree", "id"])).toBe("slate-frame");
    expect(nextLocal.has("full_id")).toBe(false);
    expect(actions._save_local_view_state_value).toHaveBeenCalledWith(
      nextLocal,
    );
    expect(actions._save_local_view_state).not.toHaveBeenCalled();
  });

  it("StructuredEditorActions does not touch to_str", () => {
    const redux = makeRedux();
    const actions = new TestStructuredActions("test-structured", redux);
    const sync = makeSyncStub();

    actions.setSyncString(sync as unknown as SyncString);
    actions.runInitSyncStringValue();

    expect(sync.to_str).not.toHaveBeenCalled();
  });
});
