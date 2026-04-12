/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*

DEVELOPMENT:

pnpm test sync.0.test.ts

*/

import { Client, fs } from "./client-test";
import { SyncString } from "../sync";
import { a_txt } from "./data";
import { once } from "@cocalc/util/async-utils";
import { legacyPatchId } from "patchflow";
import { client_db } from "@cocalc/util/schema";

// This mostly tests the trivial minimal edge cases.
describe("create a blank minimal string SyncDoc and call public methods on it", () => {
  const { client_id, project_id, path, string_id, init_queries } = a_txt();
  const client = new Client(init_queries, client_id);
  let syncstring: SyncString;

  it("creates the syncstring and wait for it to be ready", async () => {
    syncstring = new SyncString({ project_id, path, client, fs });
    expect(syncstring.get_state()).toBe("init");
    await once(syncstring, "ready");
    expect(syncstring.get_state()).toBe("ready");
  });

  it("call set_cursor_locs, an error since cursors aren't enabled", () => {
    expect(async () => {
      await syncstring.set_cursor_locs([]);
    }).rejects.toThrow("cursors are not enabled");
  });

  it("calls each public get method", () => {
    expect(syncstring.get_state()).toBe("ready");
    expect(syncstring.get_project_id()).toBe(project_id);
    expect(syncstring.get_path()).toBe(path);
    expect(syncstring.get_string_id()).toBe(string_id);
    expect(syncstring.get_my_user_id()).toBe(2);
  });

  it("the db-style get methods all fail on a string", () => {
    expect(() => syncstring.get()).toThrow(
      "queries on strings don't have meaning",
    );
    expect(() => syncstring.get_one()).toThrow(
      "queries on strings don't have meaning",
    );
    expect(() => syncstring.delete()).toThrow(
      "delete on strings doesn't have meaning",
    );
  });

  it("get the underlying doc", () => {
    // via Document
    expect(syncstring.get_doc().to_str()).toBe("");
    // directly
    expect(syncstring.to_str()).toBe("");
  });

  it("get the size via count", () => {
    expect(syncstring.count()).toBe(0);
  });

  it("get current version", () => {
    expect(syncstring.version().to_str()).toBe("");
  });

  it("get version without (removing nothing though)", () => {
    expect(syncstring.version_without([]).to_str()).toBe("");
    expect(
      syncstring.version_without([legacyPatchId(Date.now())]).to_str(),
    ).toBe("");
  });

  it("revert to version now (error since no version with this time)", () => {
    expect(() => syncstring.revert(legacyPatchId(Date.now()))).toThrow(
      "unknown time",
    );
  });

  it("undo/redo -- nothing to undo yet...", () => {
    expect(syncstring.in_undo_mode()).toBe(false);
    syncstring.undo();
    expect(syncstring.in_undo_mode()).toBe(true);
    syncstring.exit_undo_mode();
    expect(syncstring.in_undo_mode()).toBe(false);
    syncstring.redo(); // no error
  });

  it("account_id of change at given point in time gives error", () => {
    expect(() => syncstring.account_id(legacyPatchId(Date.now()))).toThrow(
      "no patch at",
    );
  });

  it("user_id of change at given point in time gives error", () => {
    expect(() => syncstring.user_id(legacyPatchId(Date.now()))).toThrow(
      "no patch at",
    );
  });

  it("get list of versions (should be empty)", () => {
    expect(syncstring.versions()).toEqual([]);
  });

  it("last changed when time began", () => {
    expect(syncstring.last_changed()).toEqual(0);
  });

  it("check ready state", async () => {
    syncstring.assert_is_ready("check ready state");
    await syncstring.wait_until_ready(); // trivial since already ready
  });

  it("wait for an already true condition", async () => {
    await syncstring.wait(() => true);
  });

  it("get cursors (error, since cursors not enabled)", async () => {
    expect(() => syncstring.get_cursors()).toThrow("cursors are not enabled");
  });

  it("set, then get, something from the settings field", async () => {
    await syncstring.set_settings({ foo: { bar: "none" } });
    expect(syncstring.get_settings().get("foo").toJS()).toEqual({
      bar: "none",
    });
  });

  it("verifies it has the full history already", () => {
    expect(syncstring.hasFullHistory()).toBe(true);
  });

  it("loads more history (which does basically nothing)", async () => {
    await syncstring.loadMoreHistory();
  });

  it("do a save (no-op, since haven't done anything yet)", async () => {
    await syncstring.save();
  });

  it("change the snapshot interval", async () => {
    await syncstring.set_snapshot_interval(17);
    expect((syncstring as any).snapshot_interval).toBe(17);
  });

  it("read only checks", async () => {
    expect(syncstring.is_read_only()).toBe(false);
  });

  it("hashes of versions", () => {
    expect(syncstring.hash_of_saved_version()).toBe(undefined);
    expect(syncstring.hash_of_live_version()).toBe(0);
    expect(syncstring.has_uncommitted_changes()).toBe(false);
  });

  it("save_to_disk requires writeFileDelta", async () => {
    delete (fs as any).writeFileDelta;
    await expect(syncstring.save_to_disk()).rejects.toThrow(
      "writeFileDelta is required for safe, atomic writes",
    );
  });

  it("save_to_disk works with writeFileDelta", async () => {
    const calls: any[] = [];
    (fs as any).writeFileDelta = async (...args: any[]) => {
      calls.push(args);
    };
    await syncstring.save_to_disk();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("close and clean up", async () => {
    expect(syncstring.get_state()).toBe("ready");
    await syncstring.close();
    expect(syncstring.get_state()).toBe("closed");
  });
});

describe("backend sync-fs watch policy", () => {
  const project_id = "12345678-1234-4234-8234-123456789abc";
  const client_id = "abcdefab-cdef-4def-8def-abcdefabcdef";

  async function openDoc(
    path: string,
    opts: {
      watchDebounce?: number;
    } = {},
  ) {
    const client = new Client({}, client_id);
    const syncFsWatch = jest.fn(async () => undefined);
    const syncFsReconcile = jest.fn(async () => undefined);
    const fs1 = {
      ...fs,
      syncFsWatch,
      syncFsReconcile,
      stat: jest.fn(async () => ({ mtime: new Date(0) })),
      readFile: jest.fn(async () => ""),
    } as any;
    const doc = new SyncString({
      project_id,
      path,
      client,
      fs: fs1,
      watchDebounce: opts.watchDebounce,
    });
    await once(doc, "ready");
    return { doc, syncFsWatch, syncFsReconcile };
  }

  it("enables backend sync-fs watch for ordinary text files", async () => {
    const { doc, syncFsWatch } = await openDoc("ordinary.txt");
    expect(syncFsWatch).toHaveBeenCalledWith(
      "ordinary.txt",
      true,
      expect.objectContaining({
        project_id,
      }),
    );
    await doc.close();
  });

  it("passes watchDebounce through to backend sync-fs watch", async () => {
    const { doc, syncFsWatch } = await openDoc("ordinary.txt", {
      watchDebounce: 75,
    });
    expect(syncFsWatch).toHaveBeenCalledWith(
      "ordinary.txt",
      true,
      expect.objectContaining({
        project_id,
        watchDebounce: 75,
      }),
    );
    await doc.close();
  });

  it("keeps chat documents off the backend sync-fs bootstrap path", async () => {
    const { doc, syncFsWatch, syncFsReconcile } =
      await openDoc("conversation.chat");
    expect(syncFsWatch).not.toHaveBeenCalled();
    expect(syncFsReconcile).not.toHaveBeenCalled();
    await doc.close();
  });

  it("emits filesystem-change for backend file patches", async () => {
    const { doc } = await openDoc("ordinary.txt");
    const handler = jest.fn();
    doc.on("filesystem-change", handler);
    (doc as any).handlePatchflowPatch({
      file: true,
      meta: undefined,
      time: legacyPatchId(Date.now()),
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        file: true,
      }),
    );
    await doc.close();
  });
});

describe("syncdoc canonical identity path policy", () => {
  const project_id = "12345678-1234-4234-8234-123456789abc";
  const client_id = "abcdefab-cdef-4def-8def-abcdefabcdef";

  function makeFs() {
    return {
      ...fs,
      syncFsWatch: jest.fn(async () => undefined),
      canonicalSyncFsPath: jest.fn(
        async (path: string) => `/mnt/cocalc/project-test/${path}`,
      ),
      canonicalSyncIdentityPath: jest.fn(
        async (path: string) => `/root/${path}`,
      ),
      realpath: jest.fn(async (path: string) => `/root/${path}`),
      stat: jest.fn(async () => ({ mtime: new Date(0) })),
      readFile: jest.fn(async () => ""),
    } as any;
  }

  it("uses sandbox-visible identity even when backend watch uses a host path", async () => {
    const doc = new SyncString({
      project_id,
      path: "ordinary.txt",
      client: new Client({}, client_id),
      fs: makeFs(),
    });
    await once(doc, "ready");
    expect(doc.get_string_id()).toBe(
      client_db.sha1(project_id, "/root/ordinary.txt"),
    );
    await doc.close();
  });

  it("uses sandbox-visible identity for chat files without backend watch", async () => {
    const doc = new SyncString({
      project_id,
      path: "conversation.chat",
      client: new Client({}, client_id),
      fs: makeFs(),
    });
    await once(doc, "ready");
    expect(doc.get_string_id()).toBe(
      client_db.sha1(project_id, "/root/conversation.chat"),
    );
    await doc.close();
  });
});

describe("syncdoc close waits for async table cleanup", () => {
  it("does not resolve close until tables have closed", async () => {
    const { client_id, project_id, path, init_queries } = a_txt();
    const client = new Client(init_queries, client_id);
    const doc = new SyncString({ project_id, path, client, fs });
    await once(doc, "ready");

    let releaseSyncstringTable!: () => void;
    let releasePatchesTable!: () => void;
    const syncstringTableClosed = new Promise<void>((resolve) => {
      releaseSyncstringTable = resolve;
    });
    const patchesTableClosed = new Promise<void>((resolve) => {
      releasePatchesTable = resolve;
    });

    (doc as any).syncstring_table = {
      close: jest.fn(async () => {
        await syncstringTableClosed;
      }),
    };
    (doc as any).patches_table = {
      close: jest.fn(async () => {
        await patchesTableClosed;
      }),
    };

    let resolved = false;
    const closePromise = doc.close().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseSyncstringTable();
    await Promise.resolve();
    expect(resolved).toBe(false);

    releasePatchesTable();
    await closePromise;
    expect(resolved).toBe(true);
  });
});

describe("syncdoc close releases the client closed-listener", () => {
  it("removes the client listener after manual close", async () => {
    const { client_id, project_id, path, init_queries } = a_txt();
    const client = new Client(init_queries, client_id);
    const doc = new SyncString({ project_id, path, client, fs });
    await once(doc, "ready");

    expect(client.listenerCount("closed")).toBe(1);
    await doc.close();
    expect(client.listenerCount("closed")).toBe(0);
  });
});
