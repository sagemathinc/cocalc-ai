import assert from "node:assert/strict";
import test from "node:test";
import { prepareArtifactPublication } from "./artifact-publication";
import { publishArtifact, readArtifact } from "@cocalc/chat";

test("publication retries are stable and attribution is turn-specific", () => {
  const args = {
    threadId: "thread",
    messageId: "message",
    payload: { title: "Plan", file: { path: "/plan.md" } },
  };
  const first = prepareArtifactPublication(args);
  assert.deepEqual(
    first,
    prepareArtifactPublication({
      ...args,
      payload: { file: args.payload.file, title: "Plan" },
    }),
  );
  assert.notEqual(
    first.artifact_id,
    prepareArtifactPublication({ ...args, messageId: "other" }).artifact_id,
  );
  assert.throws(
    () =>
      prepareArtifactPublication({
        ...args,
        payload: { ...args.payload, message_id: "forged" } as any,
      }),
    /Unexpected/,
  );
});

test("updates require the reviewed base, replay safely, and reject concurrent changes", () => {
  const rows = new Map<string, any>();
  const key = (x: any) => JSON.stringify([x.event, x.thread_id, x.sender_id]);
  const store: any = {
    get_one: (x: any) => rows.get(key(x)),
    set: (x: any) => {
      for (const row of Array.isArray(x) ? x : [x]) rows.set(key(row), row);
    },
  };
  const args = {
    threadId: "thread",
    messageId: "message",
    payload: { title: "Plan", markdown: "first" },
  };
  const first = prepareArtifactPublication(args);
  publishArtifact(store, first);
  assert.equal(publishArtifact(store, first).replayed, true);
  assert.throws(
    () =>
      prepareArtifactPublication({ ...args, artifactId: first.artifact_id }),
    /base/,
  );
  const base = readArtifact(store, first).base;
  const update = prepareArtifactPublication({
    ...args,
    artifactId: first.artifact_id,
    payload: { title: "Plan", markdown: "second", base },
  });
  publishArtifact(store, update);
  assert.equal(publishArtifact(store, update).replayed, true);
  const stale = prepareArtifactPublication({
    ...args,
    artifactId: first.artifact_id,
    payload: { title: "Plan", markdown: "third", base },
  });
  assert.throws(() => publishArtifact(store, stale), /changed|base/);
});
