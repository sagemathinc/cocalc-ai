/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { once } from "@cocalc/util/async-utils";
import { SyncString } from "../sync";
import { Client, fs } from "./client-test";
import { a_txt } from "./data";
import { Session as PatchflowSession } from "patchflow";

class AlertingClient extends Client {
  public alerts: any[] = [];

  public override alert_message(opts): void {
    this.alerts.push(opts);
  }
}

describe("patchflow commit failures", () => {
  const { client_id, project_id, path, init_queries } = a_txt();
  let client: AlertingClient;
  let syncstring: SyncString;

  afterEach(async () => {
    jest.restoreAllMocks();
    if (syncstring != null && syncstring.get_state() !== "closed") {
      await syncstring.close();
    }
  });

  it("surfaces a user-visible error and dedupes repeated failures", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    client = new AlertingClient(init_queries, client_id);
    syncstring = new SyncString({
      project_id,
      path,
      client,
      fs,
      noAutosave: true,
    });
    await once(syncstring, "ready");

    const session = (syncstring as any).patchflowSession;
    session.commit = () => {
      throw new Error("db write failed");
    };

    syncstring.from_str("a");
    expect(syncstring.commit()).toBe(true);
    syncstring.from_str("ab");
    expect(syncstring.commit()).toBe(true);

    expect(client.alerts).toHaveLength(1);
    expect(client.alerts[0]).toMatchObject({
      title: "Unable to save changes",
      type: "error",
    });
    expect(client.alerts[0].message).toContain(path);
    expect(client.alerts[0].message).toContain("db write failed");
  });

  it("retries cleanly after a transient patchflow init failure", async () => {
    jest.setTimeout(10_000);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "trace").mockImplementation(() => {});
    const originalInit = PatchflowSession.prototype.init;
    let calls = 0;
    jest.spyOn(PatchflowSession.prototype, "init").mockImplementation(function (
      this: PatchflowSession,
    ) {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("transient patchflow init failure"));
      }
      return originalInit.call(this);
    });

    client = new AlertingClient(init_queries, client_id);
    syncstring = new SyncString({
      project_id,
      path,
      client,
      fs,
      noAutosave: true,
    });

    await once(syncstring, "ready");
    expect(calls).toBeGreaterThan(1);
    expect(syncstring.to_str()).toBe("");
  });
});
