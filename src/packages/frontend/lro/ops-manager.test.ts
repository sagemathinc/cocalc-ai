describe("lro ops manager account-feed integration", () => {
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const makeSummary = (overrides: Record<string, any> = {}) => ({
    op_id: overrides.op_id ?? "op-1",
    kind: overrides.kind ?? "project-start",
    scope_type: overrides.scope_type ?? "project",
    scope_id: overrides.scope_id ?? "project-1",
    status: overrides.status ?? "running",
    created_by: overrides.created_by ?? "account-1",
    owner_type: overrides.owner_type ?? null,
    owner_id: overrides.owner_id ?? null,
    routing: overrides.routing ?? null,
    input: overrides.input ?? {},
    result: overrides.result ?? {},
    error: overrides.error ?? null,
    progress_summary: overrides.progress_summary ?? {},
    attempt: overrides.attempt ?? 0,
    heartbeat_at: overrides.heartbeat_at ?? null,
    created_at: overrides.created_at ?? new Date("2026-04-17T12:00:00Z"),
    started_at: overrides.started_at ?? null,
    finished_at: overrides.finished_at ?? null,
    dismissed_at: overrides.dismissed_at ?? null,
    dismissed_by: overrides.dismissed_by ?? null,
    updated_at: overrides.updated_at ?? new Date("2026-04-17T12:00:00Z"),
    expires_at: overrides.expires_at ?? new Date("2026-04-18T12:00:00Z"),
    dedupe_key: overrides.dedupe_key ?? null,
    parent_id: overrides.parent_id ?? null,
  });

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("single manager bootstraps once and updates from account feed without polling terminal state", async () => {
    let summaries = [
      makeSummary({
        op_id: "op-1",
        status: "succeeded",
        updated_at: new Date("2026-04-17T12:01:00Z"),
        finished_at: new Date("2026-04-17T12:01:00Z"),
      }),
    ];
    let listener: ((reason: "change" | "reset") => void) | undefined;
    const bootstrapAccountLroScope = jest.fn(
      async ({
        scope_type,
        scope_id,
        include_completed,
        listLro,
      }: {
        scope_type: "project";
        scope_id: string;
        include_completed?: boolean;
        listLro: (opts: {
          scope_type: "project";
          scope_id: string;
          include_completed?: boolean;
        }) => Promise<any[]>;
      }) => {
        summaries = await listLro({
          scope_type,
          scope_id,
          include_completed,
        });
        listener?.("change");
      },
    );
    jest.doMock("@cocalc/frontend/lite", () => ({ lite: false }));
    jest.doMock("./account-summary-feed", () => ({
      subscribeAccountLroSummaryFeed: (cb) => {
        listener = cb;
        return () => {
          if (listener === cb) {
            listener = undefined;
          }
        };
      },
      getAccountLroSummaries: () => summaries,
      bootstrapAccountLroScope,
    }));
    const { SingleLroOpsManager } = require("./ops-manager");
    const listLro = jest.fn(async () => summaries);
    const getLroStream = jest.fn();
    const setState = jest.fn();
    const manager = new SingleLroOpsManager({
      kind: "project-start",
      scope_type: "project",
      scope_id: "project-1",
      include_completed: true,
      retainTerminal: true,
      refreshMs: 10,
      listLro,
      getLroStream,
      dismissLro: jest.fn(async () => {}),
      isClosed: () => false,
      setState,
    });

    manager.init();
    await flush();

    expect(listLro).toHaveBeenCalledTimes(1);
    expect(getLroStream).not.toHaveBeenCalled();
    expect(setState.mock.calls.at(-1)?.[0]?.summary?.op_id).toBe("op-1");

    jest.advanceTimersByTime(60_000);
    await flush();
    expect(listLro).toHaveBeenCalledTimes(1);

    summaries = [
      makeSummary({
        op_id: "op-2",
        status: "failed",
        error: "boom",
        updated_at: new Date("2026-04-17T12:02:00Z"),
        finished_at: new Date("2026-04-17T12:02:00Z"),
      }),
    ];
    listener?.("change");
    await flush();

    expect(listLro).toHaveBeenCalledTimes(1);
    expect(setState.mock.calls.at(-1)?.[0]?.summary?.op_id).toBe("op-2");
    expect(setState.mock.calls.at(-1)?.[0]?.summary?.status).toBe("failed");
  });

  it("single manager periodically refreshes while tracking a nonterminal op", async () => {
    let summaries = [
      makeSummary({
        op_id: "op-1",
        status: "running",
        updated_at: new Date("2026-04-17T12:00:00Z"),
      }),
    ];
    let listener: ((reason: "change" | "reset") => void) | undefined;
    const bootstrapAccountLroScope = jest.fn(
      async ({
        scope_type,
        scope_id,
        include_completed,
        listLro,
      }: {
        scope_type: "project";
        scope_id: string;
        include_completed?: boolean;
        listLro: (opts: {
          scope_type: "project";
          scope_id: string;
          include_completed?: boolean;
        }) => Promise<any[]>;
      }) => {
        summaries = await listLro({
          scope_type,
          scope_id,
          include_completed,
        });
        listener?.("change");
      },
    );
    jest.doMock("@cocalc/frontend/lite", () => ({ lite: false }));
    jest.doMock("./account-summary-feed", () => ({
      subscribeAccountLroSummaryFeed: (cb) => {
        listener = cb;
        return () => {
          if (listener === cb) {
            listener = undefined;
          }
        };
      },
      getAccountLroSummaries: () => summaries,
      bootstrapAccountLroScope,
    }));
    const { SingleLroOpsManager } = require("./ops-manager");
    const listLro = jest.fn(async () => summaries);
    const getLroStream = jest.fn(() => new Promise<any>(() => {}));
    const setState = jest.fn();
    const manager = new SingleLroOpsManager({
      kind: "project-start",
      scope_type: "project",
      scope_id: "project-1",
      include_completed: true,
      retainTerminal: true,
      refreshMs: 10,
      listLro,
      getLroStream,
      dismissLro: jest.fn(async () => {}),
      isClosed: () => false,
      setState,
    });

    manager.track({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "project-1",
    });
    await flush();
    expect(listLro).toHaveBeenCalledTimes(1);
    expect(setState.mock.calls.at(-1)?.[0]?.summary?.status).toBe("running");

    summaries = [
      makeSummary({
        op_id: "op-1",
        status: "succeeded",
        updated_at: new Date("2026-04-17T12:01:00Z"),
        finished_at: new Date("2026-04-17T12:01:00Z"),
      }),
    ];

    jest.advanceTimersByTime(10);
    await flush();

    expect(listLro).toHaveBeenCalledTimes(2);
    expect(setState.mock.calls.at(-1)?.[0]?.summary?.status).toBe("succeeded");
  });

  it("multi manager syncs summary removals from account feed without polling terminal state", async () => {
    let summaries = [
      makeSummary({
        op_id: "op-1",
        kind: "project-backup",
        status: "succeeded",
        updated_at: new Date("2026-04-17T12:01:00Z"),
        finished_at: new Date("2026-04-17T12:01:00Z"),
      }),
      makeSummary({
        op_id: "op-2",
        kind: "project-backup",
        status: "failed",
        error: "bad",
        updated_at: new Date("2026-04-17T12:02:00Z"),
        finished_at: new Date("2026-04-17T12:02:00Z"),
      }),
    ];
    let listener: ((reason: "change" | "reset") => void) | undefined;
    const bootstrapAccountLroScope = jest.fn(
      async ({
        scope_type,
        scope_id,
        include_completed,
        listLro,
      }: {
        scope_type: "project";
        scope_id: string;
        include_completed?: boolean;
        listLro: (opts: {
          scope_type: "project";
          scope_id: string;
          include_completed?: boolean;
        }) => Promise<any[]>;
      }) => {
        summaries = await listLro({
          scope_type,
          scope_id,
          include_completed,
        });
        listener?.("change");
      },
    );
    jest.doMock("@cocalc/frontend/lite", () => ({ lite: false }));
    jest.doMock("./account-summary-feed", () => ({
      subscribeAccountLroSummaryFeed: (cb) => {
        listener = cb;
        return () => {
          if (listener === cb) {
            listener = undefined;
          }
        };
      },
      getAccountLroSummaries: () => summaries,
      bootstrapAccountLroScope,
    }));
    const { MultiLroOpsManager } = require("./ops-manager");
    const listLro = jest.fn(async () => summaries);
    const getLroStream = jest.fn(() => new Promise<any>(() => {}));
    const setState = jest.fn();
    const manager = new MultiLroOpsManager({
      kind: "project-backup",
      scope_type: "project",
      scope_id: "project-1",
      include_completed: true,
      retainTerminal: true,
      refreshMs: 10,
      listLro,
      getLroStream,
      dismissLro: jest.fn(async () => {}),
      isClosed: () => false,
      setState,
    });

    manager.init();
    await flush();

    expect(listLro).toHaveBeenCalledTimes(1);
    expect(Object.keys(setState.mock.calls.at(-1)?.[0] ?? {}).sort()).toEqual([
      "op-1",
      "op-2",
    ]);

    jest.advanceTimersByTime(60_000);
    await flush();
    expect(listLro).toHaveBeenCalledTimes(1);

    summaries = [summaries[1]];
    listener?.("change");
    await flush();

    expect(listLro).toHaveBeenCalledTimes(1);
    expect(Object.keys(setState.mock.calls.at(-1)?.[0] ?? {})).toEqual([
      "op-2",
    ]);
  });

  it("multi manager periodically refreshes while a nonterminal op is active", async () => {
    let summaries = [
      makeSummary({
        op_id: "op-1",
        kind: "project-backup",
        status: "running",
        updated_at: new Date("2026-04-17T12:00:00Z"),
      }),
    ];
    let listener: ((reason: "change" | "reset") => void) | undefined;
    const bootstrapAccountLroScope = jest.fn(
      async ({
        scope_type,
        scope_id,
        include_completed,
        listLro,
      }: {
        scope_type: "project";
        scope_id: string;
        include_completed?: boolean;
        listLro: (opts: {
          scope_type: "project";
          scope_id: string;
          include_completed?: boolean;
        }) => Promise<any[]>;
      }) => {
        summaries = await listLro({
          scope_type,
          scope_id,
          include_completed,
        });
        listener?.("change");
      },
    );
    jest.doMock("@cocalc/frontend/lite", () => ({ lite: false }));
    jest.doMock("./account-summary-feed", () => ({
      subscribeAccountLroSummaryFeed: (cb) => {
        listener = cb;
        return () => {
          if (listener === cb) {
            listener = undefined;
          }
        };
      },
      getAccountLroSummaries: () => summaries,
      bootstrapAccountLroScope,
    }));
    const { MultiLroOpsManager } = require("./ops-manager");
    const listLro = jest.fn(async () => summaries);
    const getLroStream = jest.fn(() => new Promise<any>(() => {}));
    const setState = jest.fn();
    const manager = new MultiLroOpsManager({
      kind: "project-backup",
      scope_type: "project",
      scope_id: "project-1",
      include_completed: true,
      retainTerminal: true,
      refreshMs: 10,
      listLro,
      getLroStream,
      dismissLro: jest.fn(async () => {}),
      isClosed: () => false,
      setState,
    });

    manager.track({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "project-1",
    });
    await flush();
    expect(listLro).toHaveBeenCalledTimes(1);

    summaries = [
      makeSummary({
        op_id: "op-1",
        kind: "project-backup",
        status: "succeeded",
        updated_at: new Date("2026-04-17T12:01:00Z"),
        finished_at: new Date("2026-04-17T12:01:00Z"),
      }),
    ];

    jest.advanceTimersByTime(10);
    await flush();

    expect(listLro).toHaveBeenCalledTimes(2);
    expect(setState.mock.calls.at(-1)?.[0]?.["op-1"]?.summary?.status).toBe(
      "succeeded",
    );
  });
});
