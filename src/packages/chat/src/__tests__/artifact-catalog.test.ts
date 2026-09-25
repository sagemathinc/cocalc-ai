import { extractArtifactCatalog } from "../artifact-catalog";
import { publishArtifact } from "../artifacts";

function fixture() {
  const rows: any[] = [];
  const store = {
    get_one: (key: object) =>
      rows.find((row) => Object.entries(key).every(([k, v]) => row[k] === v)),
    set: (values: any[]) => {
      for (const row of values) {
        const index = rows.findIndex(
          (x) =>
            x.event === row.event &&
            x.sender_id === row.sender_id &&
            x.thread_id === row.thread_id,
        );
        if (index < 0) rows.push(row);
        else rows[index] = row;
      }
    },
  };
  const input = {
    thread_id: "thread",
    artifact_id: "notes",
    operation_id: "op-1",
    message_id: "message",
    title: "Notes",
    markdown: "private content not copied",
  };
  const first = publishArtifact(store, input);
  return { rows, store, input, first };
}

test("extracts bounded metadata, never content or action payloads", () => {
  const { rows } = fixture();
  rows.push({ event: "chat", content: "secret conversation" });
  const items = extractArtifactCatalog(rows);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    title: "Notes",
    kind: "markdown",
    artifact_id: "notes",
  });
  expect(JSON.stringify(items)).not.toMatch(
    /private content|secret conversation/,
  );
});

test("edits use current metadata while creation remains the first publication", () => {
  const { rows, store, input, first } = fixture();
  publishArtifact(store, {
    ...input,
    operation_id: "op-2",
    base: first.base,
    title: "Renamed",
  });
  const publications = rows.filter(
    (x) => x.event === "chat-artifact-publication",
  );
  publications[0].published_at = "2026-01-01T00:00:00.000Z";
  publications[1].published_at = "2026-02-01T00:00:00.000Z";
  expect(extractArtifactCatalog(rows)[0]).toMatchObject({
    title: "Renamed",
    created_at: Date.parse(publications[0].published_at),
    publication: { operation_id: "op-2" },
  });
  expect(extractArtifactCatalog([...rows].reverse())).toEqual(
    extractArtifactCatalog(rows),
  );
});

test("unpublished drafts and removed current records are not discoverable", () => {
  const { rows } = fixture();
  expect(
    extractArtifactCatalog(rows.filter((x) => x.event === "chat-artifact")),
  ).toEqual([]);
  expect(
    extractArtifactCatalog(
      rows.filter((x) => x.event === "chat-artifact-publication"),
    ),
  ).toEqual([]);
});

test("malformed artifact metadata fails closed rather than deleting catalog entries", () => {
  const { rows } = fixture();
  rows[0].kind = "not-valid";
  expect(() => extractArtifactCatalog(rows)).toThrow();
});

test("same artifact id in separate threads stays separate", () => {
  const { rows, store, input } = fixture();
  publishArtifact(store, { ...input, thread_id: "other-thread" });
  expect(extractArtifactCatalog(rows)).toHaveLength(2);
});
