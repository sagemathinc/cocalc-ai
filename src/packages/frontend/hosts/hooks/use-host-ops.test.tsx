import { act, render } from "@testing-library/react";
import { useHostOps } from "./use-host-ops";

let summaries: any[] = [];
let listener: ((reason: "change" | "reset") => void) | undefined;

const bootstrapAccountLroScope = jest.fn(
  async ({
    scope_type,
    scope_id,
    include_completed,
    listLro,
  }: {
    scope_type: "host";
    scope_id: string;
    include_completed?: boolean;
    listLro: (opts: {
      scope_type: "host";
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

jest.mock("@cocalc/frontend/lite", () => ({ lite: false }));
jest.mock("@cocalc/frontend/lro/account-summary-feed", () => ({
  subscribeAccountLroSummaryFeed: (cb) => {
    listener = cb;
    return () => {
      if (listener === cb) {
        listener = undefined;
      }
    };
  },
  getAccountLroSummaries: () => summaries,
  bootstrapAccountLroScope: (...args) => bootstrapAccountLroScope(...args),
}));

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeSummary(overrides: Record<string, any> = {}) {
  return {
    op_id: overrides.op_id ?? "op-1",
    kind: overrides.kind ?? "host-upgrade-software",
    scope_type: overrides.scope_type ?? "host",
    scope_id: overrides.scope_id ?? "host-1",
    status: overrides.status ?? "failed",
    created_by: overrides.created_by ?? "account-1",
    owner_type: overrides.owner_type ?? null,
    owner_id: overrides.owner_id ?? null,
    routing: overrides.routing ?? null,
    input: overrides.input ?? {},
    result: overrides.result ?? {},
    error: overrides.error ?? "boom",
    progress_summary: overrides.progress_summary ?? {},
    attempt: overrides.attempt ?? 0,
    heartbeat_at: overrides.heartbeat_at ?? null,
    created_at: overrides.created_at ?? new Date("2026-04-17T12:00:00Z"),
    started_at: overrides.started_at ?? null,
    finished_at: overrides.finished_at ?? new Date("2026-04-17T12:01:00Z"),
    dismissed_at: overrides.dismissed_at ?? null,
    dismissed_by: overrides.dismissed_by ?? null,
    updated_at: overrides.updated_at ?? new Date("2026-04-17T12:01:00Z"),
    expires_at: overrides.expires_at ?? new Date("2026-04-18T12:00:00Z"),
    dedupe_key: overrides.dedupe_key ?? null,
    parent_id: overrides.parent_id ?? null,
  };
}

function TestComponent({
  hosts,
  listLro,
  getLroStream,
  onChange,
}: {
  hosts: any[];
  listLro: any;
  getLroStream: any;
  onChange: (value: ReturnType<typeof useHostOps>) => void;
}) {
  const value = useHostOps({
    hosts,
    listLro,
    getLroStream,
  });
  onChange(value);
  return null;
}

describe("useHostOps", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    summaries = [];
    listener = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("bootstraps once and updates from account feed without interval polling", async () => {
    const host = {
      id: "host-1",
      deleted: false,
      status: "running",
      last_action_status: null,
    };
    summaries = [
      makeSummary({
        op_id: "op-1",
        updated_at: new Date("2026-04-17T12:01:00Z"),
      }),
    ];
    const listLro = jest.fn(async () => summaries);
    const getLroStream = jest.fn();
    let latest: ReturnType<typeof useHostOps> | undefined;

    render(
      <TestComponent
        hosts={[host]}
        listLro={listLro}
        getLroStream={getLroStream}
        onChange={(value) => {
          latest = value;
        }}
      />,
    );

    await flush();

    expect(listLro).toHaveBeenCalledTimes(1);
    expect(getLroStream).not.toHaveBeenCalled();
    expect(latest?.hostOps["host-1"]?.summary?.op_id).toBe("op-1");

    jest.advanceTimersByTime(60_000);
    await flush();
    expect(listLro).toHaveBeenCalledTimes(1);

    summaries = [
      makeSummary({
        op_id: "op-2",
        updated_at: new Date("2026-04-17T12:02:00Z"),
        finished_at: new Date("2026-04-17T12:02:00Z"),
      }),
    ];
    listener?.("change");
    await flush();

    expect(listLro).toHaveBeenCalledTimes(1);
    expect(latest?.hostOps["host-1"]?.summary?.op_id).toBe("op-2");
  });
});
