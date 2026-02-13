import { Map } from "immutable";
import type { AppRedux } from "@cocalc/util/redux/types";
import type { SyncString } from "@cocalc/sync/editor/string/sync";
import * as openFile from "@cocalc/frontend/project/open-file";
import { TextEditorActions } from "../actions-text";

const NAME = "fast-open-test";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const PATH = "/root/test.txt";
const FAST_OPEN_LOADING_STATUS = "Loading live collaboration...";
const FAST_OPEN_HANDOFF_DIFF_STATUS =
  "Updated to the latest live collaboration state.";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeRedux(): AppRedux {
  return {
    getStore: jest.fn(),
    _set_state: jest.fn(),
    removeActions: jest.fn(),
  } as unknown as AppRedux;
}

class FastOpenHarness extends TextEditorActions {
  private state: Map<string, any>;
  private projectActions: any;

  constructor() {
    super(NAME, makeRedux());
    this.project_id = PROJECT_ID;
    this.path = PATH;
    this.doctype = "syncstring";
    this.state = Map({
      status: "",
      read_only: false,
      is_loaded: false,
    });
    this.store = this.state as any;
    this.projectActions = {
      fs: () => ({ readFile: jest.fn().mockResolvedValue("") }),
    };
    (this as any).setState = (obj: any) => {
      this.state = this.state.merge(obj);
      this.store = this.state as any;
    };
  }

  override _get_project_actions() {
    return this.projectActions;
  }

  setFastOpenEnabled(value: boolean): void {
    (this as any).optimisticFastOpenEnabled = value;
  }

  setReadFileResult(result: string | Error): void {
    const readFile = jest.fn();
    if (result instanceof Error) {
      readFile.mockRejectedValue(result);
    } else {
      readFile.mockResolvedValue(result);
    }
    this.projectActions = { fs: () => ({ readFile }) };
  }

  setSyncString(sync: Partial<SyncString>): void {
    this._syncstring = sync as SyncString;
  }

  async startOptimistic(): Promise<void> {
    (this as any).startOptimisticFastOpen();
    await flushPromises();
  }

  completeOptimistic(): void {
    (this as any).completeOptimisticFastOpen();
  }

  getState(key: string): any {
    return this.state.get(key);
  }
}

describe("fast-open optimistic state machine", () => {
  let markOpenPhase: jest.SpyInstance;
  let logOpenedTime: jest.SpyInstance;

  beforeEach(() => {
    markOpenPhase = jest
      .spyOn(openFile, "mark_open_phase")
      .mockImplementation(() => {});
    logOpenedTime = jest
      .spyOn(openFile, "log_opened_time")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("optimistic load sets is_loaded early", async () => {
    const actions = new FastOpenHarness();
    actions.setFastOpenEnabled(true);
    actions.setReadFileResult("disk-value");
    actions.setSyncString({
      get_state: jest.fn().mockReturnValue("loading"),
    } as any);

    await actions.startOptimistic();

    expect(actions.getState("is_loaded")).toBe(true);
    expect(actions.getState("value")).toBe("disk-value");
    expect(markOpenPhase).toHaveBeenCalledWith(
      PROJECT_ID,
      PATH,
      "optimistic_ready",
      { bytes: "disk-value".length },
    );
    expect(logOpenedTime).toHaveBeenCalledWith(PROJECT_ID, PATH);
  });

  it("read-only is enforced before live sync is ready", async () => {
    const actions = new FastOpenHarness();
    actions.setFastOpenEnabled(true);
    actions.setReadFileResult("draft");
    actions.setSyncString({
      get_state: jest.fn().mockReturnValue("loading"),
    } as any);

    await actions.startOptimistic();

    expect(actions.getState("read_only")).toBe(true);
    expect(actions.getState("status")).toBe(FAST_OPEN_LOADING_STATUS);
  });

  it("equal-content handoff clears loading status without diff notice", async () => {
    const actions = new FastOpenHarness();
    actions.setFastOpenEnabled(true);
    actions.setReadFileResult("same");
    actions.setSyncString({
      get_state: jest.fn().mockReturnValue("loading"),
      to_str: jest.fn().mockReturnValue("same"),
    } as any);

    await actions.startOptimistic();
    actions.completeOptimistic();

    expect(actions.getState("value")).toBe("same");
    expect(actions.getState("status")).toBe("");
    expect(markOpenPhase).toHaveBeenCalledWith(
      PROJECT_ID,
      PATH,
      "handoff_done",
    );
    expect(markOpenPhase).not.toHaveBeenCalledWith(
      PROJECT_ID,
      PATH,
      "handoff_differs",
      expect.anything(),
    );
  });

  it("differing-content handoff switches to live value and shows transient notice", async () => {
    jest.useFakeTimers();
    const actions = new FastOpenHarness();
    actions.setFastOpenEnabled(true);
    actions.setReadFileResult("disk");
    actions.setSyncString({
      get_state: jest.fn().mockReturnValue("loading"),
      to_str: jest.fn().mockReturnValue("live"),
    } as any);

    await actions.startOptimistic();
    actions.completeOptimistic();

    expect(actions.getState("value")).toBe("live");
    expect(actions.getState("status")).toBe(FAST_OPEN_HANDOFF_DIFF_STATUS);
    expect(markOpenPhase).toHaveBeenCalledWith(
      PROJECT_ID,
      PATH,
      "handoff_differs",
      { optimistic_bytes: 4, live_bytes: 4 },
    );
    jest.advanceTimersByTime(5000);
    await flushPromises();
    expect(actions.getState("status")).toBe("");
  });

  it("falls back cleanly when optimistic read fails", async () => {
    const actions = new FastOpenHarness();
    actions.setFastOpenEnabled(true);
    actions.setReadFileResult(new Error("read failed"));
    actions.setSyncString({
      get_state: jest.fn().mockReturnValue("loading"),
    } as any);

    await actions.startOptimistic();

    expect(actions.getState("is_loaded")).toBe(false);
    expect(actions.getState("value")).toBeUndefined();
    expect(actions.getState("status")).toBe("");
    expect(markOpenPhase).not.toHaveBeenCalledWith(
      PROJECT_ID,
      PATH,
      "optimistic_ready",
      expect.anything(),
    );
  });
});
