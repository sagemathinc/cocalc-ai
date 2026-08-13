/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Unit tests for the stop/drain concurrency behavior of
MarkdownConverterActions (rmd/qmd shared build logic).
*/

import { MarkdownConverterActions } from "./base-actions";
import { exec } from "../generic/client";

jest.mock("../generic/client", () => ({
  ...jest.requireActual("../generic/client"),
  exec: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConat: async () => ({}),
      dkv: async () => ({
        on() {},
        off() {},
        get() {},
        set() {},
        close() {},
      }),
    },
    time_client: {
      server_time: () => new Date(),
    },
  },
}));

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

function makeActions(): any {
  const actions: any = Object.create(MarkdownConverterActions.prototype);
  actions._state = "open";
  actions.store = { get: () => undefined };
  actions.set_status = jest.fn();
  actions.setState = jest.fn();
  return actions;
}

describe("drainPendingBuild", () => {
  it("defers the follow-up build to a later tick", async () => {
    // The drain must NOT start the build synchronously: when invoked from
    // the coordinator's setBuilding(false) inside joinBuild's finally, a
    // synchronous start would mark the client busy and make the
    // replacement-build re-check skip a newer remote build.
    const actions = makeActions();
    actions.build = jest.fn(async () => {});
    actions._pendingBuildRequest = true;

    actions.drainPendingBuild();
    expect(actions.build).not.toHaveBeenCalled();

    await tick();
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions._pendingBuildRequest).toBe(false);
  });

  it("is a no-op when the pending flag was cleared before the tick", async () => {
    const actions = makeActions();
    actions.build = jest.fn(async () => {});
    actions._pendingBuildRequest = true;

    actions.drainPendingBuild();
    // e.g. stop_build() ran before the deferred callback fired
    actions._pendingBuildRequest = false;

    await tick();
    expect(actions.build).not.toHaveBeenCalled();
  });

  it("does not build after close", async () => {
    const actions = makeActions();
    actions.build = jest.fn(async () => {});
    actions._pendingBuildRequest = true;

    actions.drainPendingBuild();
    actions._state = "closed";

    await tick();
    expect(actions.build).not.toHaveBeenCalled();
  });
});

describe("build ownership", () => {
  it("a build stopped during save cannot publish over its replacement", async () => {
    const actions = makeActions();
    actions._syncstring = {
      hash_of_saved_version: () => 1,
      get_state: () => "ready",
    };
    let resolveSaveA!: () => void;
    const saveA = new Promise<void>((resolve) => (resolveSaveA = resolve));
    const save = jest
      .fn()
      .mockImplementationOnce(() => saveA)
      .mockResolvedValue(undefined);
    actions.redux = {
      getEditorActions: () => ({ save }),
    };
    actions.project_id = "p";
    actions.path = "a.rmd";
    actions.store = {
      get: (key: string) => (key === "build_exit" ? 0 : undefined),
    };
    actions.buildCoordinator = {
      setLocalBuildId: jest.fn(),
      publishBuildStart: jest.fn(),
      publishBuildFinished: jest.fn(),
      requestStop: jest.fn(),
      reconcileRunningBuild: jest.fn(),
    };
    let resolveB!: () => void;
    const converterB = new Promise<void>((resolve) => (resolveB = resolve));
    actions.run_converter = jest.fn(() => converterB);

    const buildA = actions.build();
    await tick();
    await actions.stop_build("");
    const buildB = actions.build();
    await tick();
    expect(actions.buildCoordinator.publishBuildStart).toHaveBeenCalledTimes(1);

    resolveSaveA();
    await buildA;
    expect(actions.buildCoordinator.publishBuildStart).toHaveBeenCalledTimes(1);
    expect(actions.is_building).toBe(true);

    resolveB();
    await buildB;
  });

  it("a stopped build settling late does not clobber its replacement", async () => {
    // Reproduces the round-4 P1: build A is stopped while its converter
    // call is outstanding; replacement build B starts; A's invocation then
    // settles and must NOT record success bookkeeping or tear down B's
    // building state.
    const actions = makeActions();
    actions._syncstring = {
      hash_of_saved_version: () => 1,
      get_state: () => "ready",
    };
    actions.redux = {
      getEditorActions: () => ({ save: async () => {} }),
    };
    actions.project_id = "p";
    actions.path = "a.rmd";
    // build_exit 0 => buildSucceeded() true, so bookkeeping WOULD record
    // if ownership were not checked.
    actions.store = {
      get: (k: string) => (k === "build_exit" ? 0 : undefined),
    };

    // Build A blocks in its converter call.
    let resolveA!: () => void;
    const gateA = new Promise<void>((r) => (resolveA = r));
    actions.run_converter = jest.fn(() => gateA);
    const buildA = actions.build();
    await tick();
    expect(actions.is_building).toBe(true);

    // Stop cancels A (converter still outstanding).
    await actions.stop_build("");
    expect(actions.is_building).toBe(false);

    // Replacement build B starts and claims ownership.
    let resolveB!: () => void;
    const gateB = new Promise<void>((r) => (resolveB = r));
    actions._run_converter = jest.fn(() => gateB); // B is forced-fresh via wasStopped → uses run_converter
    actions.run_converter = jest.fn(() => gateB);
    const buildB = actions.build();
    await tick();
    expect(actions.is_building).toBe(true);

    // A settles late: B's building state and bookkeeping must survive.
    resolveA();
    await tick();
    expect(actions.is_building).toBe(true);
    expect(actions._lastBuiltHash).toBeUndefined();
    await buildA;

    // B completes normally and cleans up as the owner.
    resolveB();
    await buildB;
    await tick();
    expect(actions.is_building).toBe(false);
    expect(actions._lastBuiltHash).toBe(1);
  });

  it("an old joined-build teardown cannot clear a newer joined owner", () => {
    const actions = makeActions();
    actions.project_id = "p";
    actions.path = "a.rmd";
    actions.set_error = jest.fn();
    actions._init_build_coordinator();
    const callbacks = actions.buildCoordinator.callbacks;

    callbacks.setBuilding(true, "join-A");
    callbacks.setBuilding(true, "join-B");
    callbacks.setBuilding(false, "join-A");

    expect(actions.is_building).toBe(true);
    expect(actions._buildToken).toBe("join-B");
    expect(actions.setState).not.toHaveBeenLastCalledWith({ building: false });

    callbacks.setBuilding(false, "join-B");
    expect(actions.is_building).toBe(false);
    actions.buildCoordinator.close();
  });
});

describe("resetBuildRuntimeState", () => {
  it("resets building state without killing any process", async () => {
    const actions = makeActions();
    const mockedExec = exec as jest.MockedFunction<typeof exec>;
    mockedExec.mockClear();
    actions.is_building = true;
    actions._pendingBuildRequest = true;
    actions._lastBuiltHash = 42;
    actions.store = {
      get: (k: string) =>
        k === "job_info"
          ? {
              toJS: () => ({ type: "async", status: "running", pid: 1234 }),
            }
          : undefined,
    };

    actions.resetBuildRuntimeState();

    expect(actions.is_building).toBe(false);
    expect(actions._pendingBuildRequest).toBe(false);
    expect(actions._lastBuiltHash).toBeUndefined();
    // This spies on the lexical import used by stop_build(), not an unused
    // property on the Actions instance.
    expect(mockedExec).not.toHaveBeenCalled();
    // Stale running job marked terminated in the UI.
    expect(actions.setState).toHaveBeenCalledWith({
      job_info: expect.objectContaining({ status: "killed" }),
    });
  });
});

describe("stop_build", () => {
  it("ignores a delayed stop event for an older build", async () => {
    const actions = makeActions();
    actions._buildToken = "build-B";
    actions.is_building = true;
    const mockedExec = exec as jest.MockedFunction<typeof exec>;
    mockedExec.mockClear();

    await actions.stop_build("", "build-A");

    expect(actions._buildToken).toBe("build-B");
    expect(actions.is_building).toBe(true);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("clears a pending build request — stop means stop", async () => {
    const actions = makeActions();
    actions._pendingBuildRequest = true;

    await actions.stop_build("");

    expect(actions._pendingBuildRequest).toBe(false);
    expect(actions._buildWasStopped).toBe(true);
    // Deferred drains see the cleared flag and do nothing.
  });

  it("cancels a spacing-runner wait that is in progress", async () => {
    jest.useFakeTimers();
    try {
      const actions = makeActions();
      // Wire up run_converter via _init_converter with minimal stubs.
      actions._syncstring = {
        on: jest.fn(),
        hash_of_saved_version: () => 7,
      };
      actions.redux = {
        getStore: () => ({
          // waitUntilReady times out → the init IIFE bails after seeding
          waitUntilReady: async () => false,
          get: () => undefined,
          getIn: () => undefined,
        }),
        getProjectStore: () => ({ on: jest.fn(), removeListener: jest.fn() }),
      };
      actions._init_build_coordinator = jest.fn();
      actions._init_converter();

      actions._run_converter = jest.fn(async () => {});
      // Force the runner into its wait window.
      actions._lastConverterRun = Date.now();
      const p = actions.run_converter(42);

      // Stop while the runner is waiting: bumps the epoch.
      await actions.stop_build("");

      jest.advanceTimersByTime(10_000);
      await p;
      // The delayed run must NOT have started after the stop.
      expect(actions._run_converter).not.toHaveBeenCalled();

      // A fresh call after the stop runs immediately (spacing was reset).
      await actions.run_converter(43);
      expect(actions._run_converter).toHaveBeenCalledWith(43, undefined);
    } finally {
      jest.useRealTimers();
    }
  });
});
