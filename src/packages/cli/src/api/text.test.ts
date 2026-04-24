import assert from "node:assert/strict";
import test from "node:test";

import { createTextApi } from "./text";

function makeSession(initial = "") {
  const calls: string[] = [];
  let text = initial;
  return {
    calls,
    session: {
      wait_until_ready: async () => undefined,
      isClosed: () => false,
      close: async () => undefined,
      to_str: () => text,
      from_str: (next: string) => {
        text = next;
        calls.push("from_str");
      },
      save: async () => {
        calls.push("save");
      },
      save_to_disk: async () => {
        calls.push("save_to_disk");
      },
      historyLastVersion: () => "v1",
      hash_of_live_version: () => text.length,
    },
  };
}

function makeTextApi(session: ReturnType<typeof makeSession>["session"]) {
  return createTextApi({
    withProjectTextSession: async (_ctx, options, fn) =>
      await fn({
        project: {
          project_id: "00000000-1000-4000-8000-000000000001",
          title: "Test Project",
          host_id: null,
        },
        session,
        path: options.path,
        association: {
          basename: "a.md",
          extension: "md",
          doctype: "syncstring",
          supportsTextApi: true,
          label: "MD",
        },
      }),
  });
}

test("text write saves live syncstring changes to disk by default", async () => {
  const { session, calls } = makeSession("before");
  const api = makeTextApi(session);
  const doc = api.bindDocument(undefined, { path: "/home/user/a.md" });

  await doc.write("after");

  assert.deepEqual(calls, ["from_str", "save", "save_to_disk"]);
});

test("text append can opt out of disk save for live-only edits", async () => {
  const { session, calls } = makeSession("before");
  const api = makeTextApi(session);
  const doc = api.bindDocument(undefined, { path: "/home/user/a.md" });

  await doc.append(" after", { saveToDisk: false });

  assert.deepEqual(calls, ["from_str", "save"]);
});
