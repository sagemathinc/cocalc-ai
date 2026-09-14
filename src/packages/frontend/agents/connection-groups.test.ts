import type { PersonalConnection } from "@cocalc/conat/agents/personal";
import {
  formatConnectionTime,
  groupPersonalConnections,
  latestConnectionObservation,
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
