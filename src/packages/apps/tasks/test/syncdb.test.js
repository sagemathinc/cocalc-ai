const assert = require("node:assert/strict");
const test = require("node:test");

const { SyncDBTasksSession } = require("../dist/session/syncdb.js");

test("task mutations await syncdb.save before resolving", async () => {
  const calls = [];
  let resolveSave;

  const syncdb = {
    async wait_until_ready() {},
    isClosed() {
      return false;
    },
    async close() {},
    get() {
      return [{ task_id: "task-1", desc: "task", done: false }];
    },
    get_one(where) {
      if (where?.task_id === "task-1") {
        return { task_id: "task-1", desc: "task", done: false };
      }
      return undefined;
    },
    set(obj) {
      calls.push(`set:${JSON.stringify(obj)}`);
    },
    delete(where) {
      calls.push(`delete:${JSON.stringify(where)}`);
    },
    commit() {
      calls.push("commit");
      return true;
    },
    async save() {
      calls.push("save:start");
      await new Promise((resolve) => {
        resolveSave = () => {
          calls.push("save:end");
          resolve();
        };
      });
    },
  };

  const session = await SyncDBTasksSession.open(syncdb);
  const pending = session.setDone("task-1", true);

  await Promise.resolve();
  assert.match(calls[0], /^set:\{"task_id":"task-1","desc":"task","done":true/);
  assert.deepEqual(calls.slice(1), ["commit", "save:start"]);

  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);

  resolveSave?.();
  await pending;
  assert.equal(resolved, true);
  assert.match(calls[0], /^set:\{"task_id":"task-1","desc":"task","done":true/);
  assert.deepEqual(calls.slice(1), ["commit", "save:start", "save:end"]);
});

test("task mutations await syncdb.save_to_disk before resolving", async () => {
  const calls = [];
  let resolveSaveToDisk;

  const syncdb = {
    async wait_until_ready() {},
    isClosed() {
      return false;
    },
    async close() {},
    get() {
      return [{ task_id: "task-1", desc: "task", done: false }];
    },
    get_one(where) {
      if (where?.task_id === "task-1") {
        return { task_id: "task-1", desc: "task", done: false };
      }
      return undefined;
    },
    set(obj) {
      calls.push(`set:${JSON.stringify(obj)}`);
    },
    delete(where) {
      calls.push(`delete:${JSON.stringify(where)}`);
    },
    commit() {
      calls.push("commit");
      return true;
    },
    async save() {
      calls.push("save");
    },
    async save_to_disk() {
      calls.push("save_to_disk:start");
      await new Promise((resolve) => {
        resolveSaveToDisk = () => {
          calls.push("save_to_disk:end");
          resolve();
        };
      });
    },
  };

  const session = await SyncDBTasksSession.open(syncdb);
  const pending = session.setDone("task-1", true);

  await Promise.resolve();
  assert.deepEqual(calls.slice(1), ["commit", "save", "save_to_disk:start"]);

  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);

  resolveSaveToDisk?.();
  await pending;
  assert.equal(resolved, true);
  assert.deepEqual(calls.slice(1), [
    "commit",
    "save",
    "save_to_disk:start",
    "save_to_disk:end",
  ]);
});
