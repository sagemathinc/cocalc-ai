import type { PersonalConnection } from "@cocalc/conat/agents/personal";
import {
  formatConnectionTime,
  groupPersonalConnections,
  groupPersonalConnectionPairs,
  latestConnectionObservation,
  summarizeConnectionPair,
} from "./connection-groups";

const source = { project_id: "project-a", agent_id: "agent-a" };
const target = { project_id: "project-b", agent_id: "agent-b" };
const forward = {
  source,
  target,
  link_id: "forward",
  direction_group_id: "pair",
} as PersonalConnection;
const reverse = {
  ...forward,
  source: target,
  target: source,
  link_id: "reverse",
};

test("reciprocal directions group by their shared grant group, independent of listing order", () => {
  expect(groupPersonalConnections([reverse, forward])).toEqual([
    { id: "pair", connections: [forward, reverse], bidirectional: true },
  ]);
  expect(groupPersonalConnections([forward, reverse])).toEqual(
    groupPersonalConnections([reverse, forward]),
  );
});
test("independently approved one-way grants are not combined by matching endpoints", () => {
  const groups = groupPersonalConnections([
    forward,
    { ...reverse, direction_group_id: "separate" },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups.map((group) => group.bidirectional)).toEqual([false, false]);
});
test("multiple records without reciprocal endpoints do not claim bidirectional communication", () => {
  expect(
    groupPersonalConnections([forward, { ...forward, link_id: "duplicate" }])[0]
      .bidirectional,
  ).toBe(false);
});
test("observations use the latest valid timestamp, not array order or missing values", () => {
  expect(
    latestConnectionObservation(
      [
        { ...forward, last_attempt_at: "2026-09-14T12:00:00Z" },
        { ...reverse, last_attempt_at: "2026-09-13T12:00:00Z" },
        { ...reverse, last_attempt_at: "invalid" },
      ],
      "last_attempt_at",
    ),
  ).toBe("2026-09-14T12:00:00.000Z");
  expect(
    latestConnectionObservation(
      [forward, { ...reverse, last_attempt_at: null }],
      "last_attempt_at",
    ),
  ).toBeUndefined();
});
test.each([undefined, null, "", "invalid"])(
  "unknown timestamps stay unknown: %p",
  (value) => {
    expect(formatConnectionTime(value)).toBe("Unknown");
  },
);

test("renewals collapse terminal approvals, irrespective of direction or response order", () => {
  const current = {
    ...forward,
    status: "active",
    expires_at: null,
    created_at: "2026-09-14T01:00:00Z",
  } as PersonalConnection;
  const old = {
    ...reverse,
    direction_group_id: "old",
    status: "expired",
    created_at: "2026-09-13T01:00:00Z",
  } as PersonalConnection;
  const [pair] = groupPersonalConnectionPairs([old, current]);
  expect(pair.visible.map((g) => g.id)).toEqual(["pair"]);
  expect(pair.history.map((g) => g.id)).toEqual(["old"]);
  expect(groupPersonalConnectionPairs([current, old])).toEqual([pair]);
});

test("a newer expired or revoked approval never hides an older still-usable permission", () => {
  const current = {
    ...forward,
    status: "active",
    expires_at: null,
  } as PersonalConnection;
  for (const status of ["expired", "revoked"]) {
    const newer = {
      ...current,
      direction_group_id: "new",
      status,
      created_at: "2026-09-14T01:00:00Z",
    } as PersonalConnection;
    expect(
      groupPersonalConnectionPairs([newer, current])[0].visible.map(
        (g) => g.id,
      ),
    ).toEqual(["pair"]);
  }
});

test("independently current and paused approvals remain visible; paused expired rows become history", () => {
  const rows = [
    { ...forward, status: "active", expires_at: null },
    {
      ...reverse,
      direction_group_id: "paused",
      status: "paused",
      expires_at: null,
    },
    {
      ...forward,
      direction_group_id: "old",
      status: "paused",
      expires_at: "2026-09-13T00:00:00Z",
    },
  ] as PersonalConnection[];
  const [pair] = groupPersonalConnectionPairs(
    rows,
    Date.parse("2026-09-14T00:00:00Z"),
  );
  expect(pair.visible.map((g) => g.id).sort()).toEqual(["pair", "paused"]);
  expect(pair.history.map((g) => g.id)).toEqual(["old"]);
});

test("without a current approval show the most recent for renewal; unrelated pairs stay separate", () => {
  const old = {
    ...forward,
    status: "expired",
    created_at: "2026-09-12T00:00:00Z",
  } as PersonalConnection;
  const newest = {
    ...old,
    direction_group_id: "newest",
    status: "revoked",
    created_at: "2026-09-13T00:00:00Z",
  } as PersonalConnection;
  const unrelated = {
    ...old,
    direction_group_id: "other",
    target: { ...target, agent_id: "other" },
  };
  const pairs = groupPersonalConnectionPairs([old, newest, unrelated]);
  expect(pairs).toHaveLength(2);
  expect(pairs[0].visible.map((g) => g.id)).toEqual(["newest"]);
  expect(pairs[0].history.map((g) => g.id)).toEqual(["pair"]);
});

test("table direction is the union of active grants, not paused or historical directions", () => {
  const now = Date.parse("2026-09-14T00:00:00Z");
  const active = {
    ...forward,
    status: "active",
    expires_at: null,
  } as PersonalConnection;
  const back = {
    ...reverse,
    direction_group_id: "other",
    status: "active",
    expires_at: null,
  } as PersonalConnection;
  const summary = (rows: PersonalConnection[], paused = false) =>
    summarizeConnectionPair(
      groupPersonalConnectionPairs(rows, now)[0],
      paused,
      now,
    );
  expect(summary([active, back])).toMatchObject({
    label: "Both ways",
    forward: true,
    reverse: true,
  });
  expect(summary([active, { ...back, paused: true }])).toMatchObject({
    label: "One way",
  });
  expect(summary([active, { ...back, status: "revoked" }])).toMatchObject({
    label: "One way",
  });
  expect(
    summary([{ ...active, expires_at: "2026-09-13T00:00:00Z" }]),
  ).toMatchObject({ label: "None", forward: false, reverse: false });
  expect(summary([{ ...active, paused: true }])).toMatchObject({
    label: "Paused",
  });
  expect(summary([active, back], true)).toMatchObject({
    label: "Paused globally",
    forward: false,
    reverse: false,
  });
});
