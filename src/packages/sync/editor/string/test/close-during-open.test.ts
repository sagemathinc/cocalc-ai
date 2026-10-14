/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A document closed while it is still opening must not be left with a live
patchflow session: close() only closes a session that already exists, and a
session created or initialized afterwards would outlive the document.
*/

import { Session } from "patchflow";
import { Client, fs } from "./client-test";
import { SyncString } from "../sync";
import { a_txt } from "./data";

jest.setTimeout(20000);

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

describe("closing a document while it opens", () => {
  const { project_id, path, init_queries } = a_txt();
  const originalInit = Session.prototype.init;
  let sessions: Session[];
  let init: jest.SpyInstance;

  beforeEach(() => {
    sessions = [];
    init = jest
      .spyOn(Session.prototype, "init")
      .mockImplementation(async function (this: Session) {
        sessions.push(this);
        return await originalInit.call(this);
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates no session when closed while the cursor channel opens", async () => {
    let resolveAdapter!: (adapter: undefined) => void;
    const createAdapter = jest
      .spyOn(SyncString.prototype as any, "createCursorPresenceAdapter")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveAdapter = resolve;
          }),
      );
    const sync = new SyncString({
      project_id,
      path,
      client: new Client(init_queries, "userA"),
      fs,
      cursors: true,
      string_id: "close-during-cursor-open",
    });
    await until(() => createAdapter.mock.calls.length > 0);
    const closing = sync.close();
    resolveAdapter(undefined);
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessions.filter((session) => !session.closed)).toEqual([]);
  });

  it("closes a session again when its document closed during init", async () => {
    // Session.init can subscribe even after Session.close, so the session
    // must be closed once more after init finishes.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initialized = new Set<Session>();
    const closedAfterInit = new Set<Session>();
    init.mockImplementation(async function (this: Session) {
      sessions.push(this);
      await gate;
      try {
        await originalInit.call(this);
      } finally {
        initialized.add(this);
      }
    });
    const originalClose = Session.prototype.close;
    jest.spyOn(Session.prototype, "close").mockImplementation(function (
      this: Session,
    ) {
      if (initialized.has(this)) closedAfterInit.add(this);
      return originalClose.call(this);
    });
    const sync = new SyncString({
      project_id,
      path,
      client: new Client(init_queries, "userB"),
      fs,
      cursors: true,
      string_id: "close-during-session-init",
    });
    await until(() => sessions.length > 0);
    const closing = sync.close();
    release();
    await closing;
    await until(() => sessions.every((session) => initialized.has(session)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(closedAfterInit.has(session)).toBe(true);
    }
  });
});
