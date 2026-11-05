import {
  activeAgentTurnProjects,
  endedAgentTurnProjects,
  readAgentTurns,
} from "./agent-turns";

const NOW = 1_800_000_000_000;
const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const FRESH = 120_000;

function lease(
  project_id: string,
  {
    state = "running",
    started_at = NOW - 60_000,
    heartbeat_at = NOW - 1_000,
    ended_at = null,
  }: {
    state?: string;
    started_at?: number;
    heartbeat_at?: number;
    ended_at?: number | null;
  } = {},
): any {
  return {
    project_id,
    path: "a.chat",
    message_date: `${started_at}`,
    state,
    owner_instance_id: "worker",
    started_at,
    heartbeat_at,
    ended_at,
  };
}

describe("activeAgentTurnProjects", () => {
  test("a fresh running lease protects its project", () => {
    const { projects, invalid } = activeAgentTurnProjects([lease(P)], {
      now: NOW,
      freshMs: FRESH,
    });
    expect([...projects.keys()]).toEqual([P]);
    expect(invalid).toBe(0);
  });

  test("a stale heartbeat protects nothing, and is not counted invalid", () => {
    const { projects, invalid } = activeAgentTurnProjects(
      [lease(P, { heartbeat_at: NOW - FRESH - 1 })],
      { now: NOW, freshMs: FRESH },
    );
    expect(projects.size).toBe(0);
    expect(invalid).toBe(0);
  });

  test("a future heartbeat, a bad start time or a malformed id is ignored and counted", () => {
    const { projects, invalid } = activeAgentTurnProjects(
      [
        lease(P, { heartbeat_at: NOW + 1 }),
        lease(P, { started_at: NOW - 500, heartbeat_at: NOW - 1_000 }),
        lease(P, { started_at: 0 }),
        lease("not-a-uuid"),
        lease(`${Q}; drop`),
      ],
      { now: NOW, freshMs: FRESH },
    );
    expect(projects.size).toBe(0);
    expect(invalid).toBe(5);
  });

  test("ended leases never protect", () => {
    for (const state of ["completed", "error", "aborted"]) {
      const { projects } = activeAgentTurnProjects([lease(P, { state })], {
        now: NOW,
        freshMs: FRESH,
      });
      expect(projects.size).toBe(0);
    }
  });

  test("there is no age limit: a fresh lease from a 10 h turn still protects", () => {
    const { projects } = activeAgentTurnProjects(
      [lease(P, { started_at: NOW - 10 * 3600_000 })],
      { now: NOW, freshMs: FRESH },
    );
    expect([...projects.keys()]).toEqual([P]);
  });

  test("each lease is checked on its own: any eligible lease protects; the newest start is kept", () => {
    const { projects } = activeAgentTurnProjects(
      [
        lease(P, {
          started_at: NOW - 5 * 3600_000,
          heartbeat_at: NOW - 600_000,
        }),
        lease(P, { started_at: NOW - 30_000 }),
        lease(P, { started_at: NOW - 90_000 }),
      ],
      { now: NOW, freshMs: FRESH },
    );
    expect(projects.get(P)).toEqual({ started_at: NOW - 30_000, leases: 2 });
    // The stale one alone protects nothing.
    expect(
      activeAgentTurnProjects(
        [
          lease(P, {
            started_at: NOW - 5 * 3600_000,
            heartbeat_at: NOW - 600_000,
          }),
        ],
        { now: NOW, freshMs: FRESH },
      ).projects.size,
    ).toBe(0);
  });

  test("ids are normalized to lower case", () => {
    const { projects } = activeAgentTurnProjects([lease(P.toUpperCase())], {
      now: NOW,
      freshMs: FRESH,
    });
    expect([...projects.keys()]).toEqual([P]);
  });

  test("the optional per-host cap keeps the newest turns; off by default", () => {
    const rows = [
      lease(P, { started_at: NOW - 60_000 }),
      lease(Q, { started_at: NOW - 10_000 }),
    ];
    expect(
      activeAgentTurnProjects(rows, {
        now: NOW,
        freshMs: FRESH,
        maxProjects: 0,
      }).projects.size,
    ).toBe(2);
    expect([
      ...activeAgentTurnProjects(rows, {
        now: NOW,
        freshMs: FRESH,
        maxProjects: 1,
      }).projects.keys(),
    ]).toEqual([Q]);
  });
});

describe("endedAgentTurnProjects", () => {
  const ended = (
    project_id: string,
    ended_at: number,
    started_at = NOW - 60_000,
  ) => lease(project_id, { state: "completed", started_at, ended_at });

  test("projects whose turns ended in (endedAfter, now], deduplicated", () => {
    const { projects, invalid } = endedAgentTurnProjects(
      [ended(P, NOW - 30_000), ended(P, NOW - 20_000), ended(Q, NOW - 10_000)],
      { now: NOW, endedAfter: NOW - 60_000 },
    );
    expect([...projects].sort()).toEqual([P, Q].sort());
    expect(invalid).toBe(0);
  });

  test("ended_at must be > 0, <= now, after the cursor and >= started_at", () => {
    const { projects, invalid } = endedAgentTurnProjects(
      [
        ended(P, 0),
        ended(P, NOW + 1),
        ended(P, NOW - 60_000),
        ended(P, NOW - 50_000, NOW - 40_000),
        ended("bad", NOW - 10_000),
      ],
      { now: NOW, endedAfter: NOW - 60_000 },
    );
    expect(projects.size).toBe(0);
    expect(invalid).toBe(5);
  });
});

describe("readAgentTurns", () => {
  test("one read: live projects, ended projects and the next cursor", () => {
    const list = jest.fn(() => ({
      running: [lease(P)],
      ended: [lease(Q, { state: "completed", ended_at: NOW - 5_000 })],
      ended_truncated: false,
    }));
    const read = readAgentTurns({ now: NOW, endedAfter: NOW - 60_000, list });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([...read.projects.keys()]).toEqual([P]);
    expect([...read.ended]).toEqual([Q]);
    expect(read.ended_cursor).toBe(NOW);
    expect(list).toHaveBeenCalledWith({
      now: NOW,
      heartbeat_since: NOW - FRESH,
      ended_after: NOW - 60_000,
    });
  });

  test("a truncated ended read moves the cursor only to its last row", () => {
    const read = readAgentTurns({
      now: NOW,
      endedAfter: NOW - 60_000,
      list: () => ({
        running: [],
        ended: [lease(Q, { state: "completed", ended_at: NOW - 40_000 })],
        ended_truncated: true,
      }),
    });
    expect(read.ok && read.ended_cursor).toBe(NOW - 40_000);
  });

  test("a failed read is { ok: false }, never an empty set", () => {
    const read = readAgentTurns({
      now: NOW,
      list: () => {
        throw Error("database is locked");
      },
    });
    expect(read).toEqual({ ok: false });
  });
});
