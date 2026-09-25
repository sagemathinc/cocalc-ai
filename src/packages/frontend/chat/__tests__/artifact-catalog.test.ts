import { EventEmitter } from "events";
import { artifactKey, publishArtifact } from "@cocalc/chat";
import { artifactCatalog, filterArtifacts } from "../artifact-catalog";

export function fixture() {
  const rows: any[] = [];
  const matches = (row, where) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const syncdb = Object.assign(new EventEmitter(), {
    get: (where) => rows.filter((row) => matches(row, where)),
    get_one: (where) => rows.find((row) => matches(row, where)),
    set: (value) => {
      for (const row of Array.isArray(value) ? value : [value]) {
        const index = rows.findIndex(
          (r) =>
            r.sender_id === row.sender_id &&
            r.date === row.date &&
            r.thread_id === row.thread_id,
        );
        if (index < 0) rows.push(row);
        else rows[index] = { ...rows[index], ...row };
      }
    },
  });
  const publish = (thread_id: string, title: string, operation_id = "first") =>
    publishArtifact(syncdb, {
      thread_id,
      artifact_id: "doc",
      title,
      markdown: "original words",
      operation_id,
      message_id: "message",
    });
  publish("one", "Zebra");
  publish("two", "Alpha");
  return { rows, syncdb, publish };
}

test("catalog deduplicates per thread, indexes current content, and tolerates malformed rows", () => {
  const { rows, syncdb } = fixture();
  const first = rows.find((r) => r.event === "chat-artifact-publication");
  // A second validated publication for the same artifact.
  const { artifactPublicationKey } = jest.requireActual("@cocalc/chat");
  rows.push({
    ...first,
    ...artifactPublicationKey(first, "second"),
    operation_id: "second",
    published_at: "2099-01-01T00:00:00Z",
  });
  rows.push({ event: "chat-artifact-publication", bad: true });
  syncdb.set({
    ...artifactKey({ thread_id: "one", artifact_id: "doc" }),
    input: "edited unique needle",
  });
  const entries = artifactCatalog(syncdb);
  expect(entries).toHaveLength(2);
  expect(filterArtifacts(entries, { query: "unique needle" })).toHaveLength(1);
  expect(
    filterArtifacts(entries, { query: "unique", threadId: "two" }),
  ).toHaveLength(0);
  expect(
    filterArtifacts(entries, { sort: "title" }).map((r) => r.title),
  ).toEqual(["Alpha", "Zebra"]);
  expect(filterArtifacts(entries, {})[0].publication.operation_id).toBe(
    "second",
  );
  expect(filterArtifacts(entries, { kind: "file" })).toHaveLength(0);
});

test("publication remains discoverable without a current record", () => {
  const { rows, syncdb } = fixture();
  rows.splice(
    rows.findIndex((r) => r.event === "chat-artifact"),
    1,
  );
  expect(
    filterArtifacts(artifactCatalog(syncdb), { query: "Zebra" })[0].current,
  ).toBeUndefined();
});
