import { extractCollaborationMetadata } from "../collaborators";
import { publishArtifact } from "../artifacts";
import { COLLABORATION_PARTICIPANT_SUMMARY_LIMIT } from "@cocalc/util/collaborators";

const account = "11111111-1111-4111-8111-111111111111";
const source = {
  project_id: "22222222-2222-4222-8222-222222222222",
  chat_path: "/home/user/a.chat",
};
const rows = [
  {
    event: "chat-thread",
    thread_id: "human",
    created_by: account,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    event: "chat-thread-config",
    thread_id: "human",
    name: "Discussion",
    agent_kind: "none",
  },
  {
    event: "chat",
    thread_id: "human",
    message_id: "m1",
    date: "2026-01-02T00:00:00Z",
    sender_id: account,
    history: [{ content: "private @agent mention" }],
  },
  {
    event: "chat-thread-config",
    thread_id: "agent",
    agent_kind: "acp",
    acp_config: { secret: "never copy configuration" },
  },
];

test("discovers humans and unnamed agents without aliases or transcript/configuration leakage", () => {
  const result = extractCollaborationMetadata(rows, source);
  expect(result.resources).toHaveLength(2);
  expect(result.resources.find((r) => r.kind === "conversation")).toMatchObject(
    {
      resource_id: "human",
      title: "Discussion",
      created_by: account,
      participant_ids: [account],
    },
  );
  expect(result.resources.find((r) => r.kind === "agent")).toMatchObject({
    resource_id: "agent-thread:agent",
    title: "Untitled agent",
  });
  expect(JSON.stringify(result)).not.toMatch(/private|secret|never copy/);
  expect(result.activity_ids.human).toEqual(["m1"]);
});

test("ordering, path and metadata changes preserve native identities and activity evidence", () => {
  const before = extractCollaborationMetadata(rows, source);
  const changed = rows.map((row) =>
    row.event === "chat-thread-config"
      ? { ...row, name: "Renamed", updated_at: "2026-09-01T00:00:00Z" }
      : row,
  );
  const after = extractCollaborationMetadata([...changed].reverse(), {
    ...source,
    chat_path: "/home/user/moved.chat",
  });
  expect(after.resources.map((r) => r.resource_id)).toEqual(
    before.resources.map((r) => r.resource_id),
  );
  expect(after.activity_ids).toEqual(before.activity_ids);
  expect(
    after.resources.find((r) => r.resource_id === "human")!.updated_at,
  ).toBe(before.resources.find((r) => r.resource_id === "human")!.updated_at);
});

test("unknown legacy identities and duplicate metadata fail the whole snapshot", () => {
  expect(() =>
    extractCollaborationMetadata(
      [...rows, { event: "chat", date: "2020-01-01" }],
      source,
    ),
  ).toThrow(/durable/);
  expect(() =>
    extractCollaborationMetadata([...rows, rows[1]], source),
  ).toThrow(/duplicate/);
  expect(() =>
    extractCollaborationMetadata([...rows, rows[2]], source),
  ).toThrow(/duplicate/);
});
test("legacy human follow/mute migration hints survive extraction without becoming participant facts", () => {
  const other = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const result = extractCollaborationMetadata(
    rows.map((row) =>
      row.event === "chat-thread-config"
        ? {
            ...row,
            notification_followers: [other, account, other],
            notification_muted: [other],
          }
        : row,
    ),
    source,
  );
  expect(result.resources.find((r) => r.kind === "conversation")).toMatchObject(
    {
      notification_followers: [account, other.toLowerCase()],
      notification_muted: [other.toLowerCase()],
      participant_ids: [account],
    },
  );
  expect(result.resources.find((r) => r.kind === "agent")).not.toHaveProperty(
    "notification_followers",
  );
  expect(result.activity_ids.human).toEqual(["m1"]);
});
test("invalid and oversized legacy attention arrays fail rather than silently lose mute policy", () => {
  for (const notification_muted of [
    ["invalid"],
    Array(1001).fill(account),
    "not an array",
  ]) {
    expect(() =>
      extractCollaborationMetadata(
        [{ ...rows[1], notification_muted }],
        source,
      ),
    ).toThrow();
  }
});

test("published artifacts are indexed without inferring publisher from thread creator", () => {
  const artifacts: any[] = [];
  publishArtifact(
    {
      get_one: (key: any) =>
        artifacts.find((r) =>
          Object.entries(key).every(([k, v]) => r[k] === v),
        ),
      set: (values: any[]) => artifacts.push(...values),
    },
    {
      thread_id: "human",
      artifact_id: "notes",
      operation_id: "publication-1",
      message_id: "m1",
      title: "Notes",
      markdown: "private artifact body",
    },
  );
  const result = extractCollaborationMetadata([...rows, ...artifacts], source);
  const artifact = result.resources.find((r) => r.kind === "artifact")!;
  expect(artifact).toMatchObject({
    title: "Notes",
    artifact_id: "notes",
    participant_ids: [],
  });
  expect(artifact.created_by).toBeUndefined();
  expect(result.activity_ids[artifact.resource_id]).toEqual(["publication-1"]);
  expect(JSON.stringify(result)).not.toContain("private artifact body");
  expect(artifact.resource_id).toMatch(/^artifact:[0-9a-f-]{36}$/);
  const moved = extractCollaborationMetadata([...rows, ...artifacts], {
    ...source,
    chat_path: "/home/user/moved.chat",
  });
  expect(moved.resources.find((r) => r.kind === "artifact")!.resource_id).toBe(
    artifact.resource_id,
  );
});

test("participant summary boundary retains the conversation and declares partial person coverage", () => {
  const people = Array.from(
    { length: COLLABORATION_PARTICIPANT_SUMMARY_LIMIT + 1 },
    (_, i) => ({
      event: "chat",
      thread_id: "large-room",
      message_id: `m-${i}`,
      sender_id: `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`,
      date: "2026-09-27T00:00:00Z",
    }),
  );
  const full = extractCollaborationMetadata(people.slice(0, -1), source);
  expect(full.resources[0].participant_ids).toHaveLength(
    COLLABORATION_PARTICIPANT_SUMMARY_LIMIT,
  );
  expect(full.resources[0].participants_truncated).toBe(false);
  expect(full.coverage).not.toBe("partial");
  const partial = extractCollaborationMetadata(people, source);
  expect(partial.resources).toHaveLength(1);
  expect(partial.resources[0]).toMatchObject({
    participant_count: COLLABORATION_PARTICIPANT_SUMMARY_LIMIT + 1,
    participants_truncated: true,
  });
  expect(partial.resources[0].participant_ids).toHaveLength(
    COLLABORATION_PARTICIPANT_SUMMARY_LIMIT,
  );
  expect(partial.activity_ids[partial.resources[0].resource_id]).toHaveLength(
    people.length,
  );
  expect(partial.coverage).toBe("partial");
  expect(partial.coverage_message).toMatch(/not available to person filters/);
  expect(extractCollaborationMetadata([...people].reverse(), source)).toEqual(
    partial,
  );
});

test("a thousand participants do not remove a high-membership human conversation", () => {
  const people = Array.from({ length: 1000 }, (_, i) => ({
    event: "chat",
    thread_id: "class-discussion",
    message_id: `m-${i}`,
    sender_id: `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`,
    date: "2026-09-27T00:00:00Z",
  }));
  const result = extractCollaborationMetadata(people, source);
  expect(result.resources).toHaveLength(1);
  expect(result.resources[0].participant_count).toBe(1000);
  expect(result.resources[0].participant_ids).toHaveLength(
    COLLABORATION_PARTICIPANT_SUMMARY_LIMIT,
  );
  expect(result.activity_ids["class-discussion"]).toHaveLength(1000);
  expect(result.coverage).toBe("partial");
});
test("rotated histories retain thread resources and last activity while declaring incomplete historical participation", () => {
  const result = extractCollaborationMetadata(
    rows
      .filter((row) => row.event !== "chat")
      .map((row) =>
        row.event === "chat-thread-config"
          ? {
              ...row,
              archived_chat_rows: 100,
              latest_chat_date_ms: Date.parse("2026-09-01"),
            }
          : row,
      ),
    source,
  );
  expect(result.resources).toHaveLength(2);
  expect(result.resources.find((r) => r.resource_id === "human")).toMatchObject(
    { updated_at: Date.parse("2026-09-01"), participant_ids: [] },
  );
  expect(
    result.resources.find((r) => r.resource_id === "human")!.participant_count,
  ).toBeUndefined();
  expect(result.coverage).toBe("partial");
  expect(result.coverage_message).toMatch(/Archived message history/);
});
