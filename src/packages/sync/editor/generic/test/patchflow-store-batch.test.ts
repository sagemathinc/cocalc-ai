/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { legacyPatchId, type PatchEnvelope } from "patchflow";
import { once } from "@cocalc/util/async-utils";
import { SyncString } from "../../string/sync";
import { Client, fs } from "../../string/test/client-test";
import { a_txt } from "../../string/test/data";

describe("SyncDoc patchflow store change batching", () => {
  async function openSyncString() {
    const { client_id, project_id, path, init_queries } = a_txt();
    const doc = new SyncString({
      project_id,
      path,
      client: new Client(init_queries, client_id),
      fs,
    });
    await once(doc, "ready");
    return doc;
  }

  it("coalesces same-tick patch table changes before applying them", async () => {
    const doc = await openSyncString();
    const table = new EventEmitter() as EventEmitter & {
      on: jest.Mock;
      off: jest.Mock;
    };
    table.on = jest.fn(table.on.bind(table));
    table.off = jest.fn(table.off.bind(table));

    const envA = { time: legacyPatchId(1), patch: [] } as PatchEnvelope;
    const envB = { time: legacyPatchId(2), patch: [] } as PatchEnvelope;
    const applyPatchflowRemoteEnvelopes = jest.fn();
    const target: any = doc;
    target.patches_table = table;
    target.patchflowEnvelopesForKeys = jest.fn(() => [envA, envB]);
    target.applyPatchflowRemoteEnvelopes = applyPatchflowRemoteEnvelopes;

    const store = target.createPatchflowStore();
    const onEnvelope = jest.fn();
    store.subscribe(onEnvelope);

    table.emit("change", ["a"]);
    table.emit("change", ["b"]);
    await Promise.resolve();

    expect(target.patchflowEnvelopesForKeys).toHaveBeenCalledTimes(1);
    expect(target.patchflowEnvelopesForKeys).toHaveBeenCalledWith(["a", "b"]);
    expect(applyPatchflowRemoteEnvelopes).toHaveBeenCalledWith(
      [envA, envB],
      onEnvelope,
    );
    await doc.close();
  });

  it("uses Patchflow's remote batch API", async () => {
    const doc = await openSyncString();
    const envA = { time: legacyPatchId(1000), patch: [], version: 4 };
    const envB = { time: legacyPatchId(2000), patch: [], version: 5 };
    const session = Object.assign(new EventEmitter(), {
      applyRemoteBatch: jest.fn(),
      close: jest.fn(),
    });
    const target: any = doc;
    target.patchflowSession = session;

    const applied = target.applyPatchflowRemoteBatch([envA, envB]);

    expect(applied).toBe(true);
    expect(session.applyRemoteBatch).toHaveBeenCalledWith([envA, envB]);
    await doc.close();
  });
});
