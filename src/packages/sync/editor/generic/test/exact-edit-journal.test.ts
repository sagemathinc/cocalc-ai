/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { once } from "@cocalc/util/async-utils";
import { make_patch } from "@cocalc/util/dmp";
import { SyncString } from "../../string/sync";
import { Client, fs } from "../../string/test/client-test";
import { a_txt } from "../../string/test/data";

describe("SyncDoc exact edit journal commits", () => {
  const { client_id, project_id, path, init_queries } = a_txt();
  const open = async (trustedAccountId?: string) => {
    const doc = new SyncString({
      project_id,
      path,
      client: new Client(init_queries, client_id),
      fs,
      noAutosave: true,
      trustedAccountId,
    });
    await once(doc, "ready");
    return doc;
  };

  it("persists the supplied patch without recomputing a diff", async () => {
    const doc = await open("00000000-0000-4000-8000-000000000001");
    const exactPatch = make_patch("", "new text");
    const diff = jest
      .spyOn((doc as any).patchflowCodec, "makePatch")
      .mockImplementation(() => {
        throw new Error("whole-document diff must not run");
      });

    const env = await doc.commitExactPatch(exactPatch, {
      meta: { essential_edit_journal: { journal_id: "j", sequence: 1 } },
    });

    expect(env?.patch).toBe(exactPatch);
    expect(diff).not.toHaveBeenCalled();
    expect(doc.to_str()).toBe("new text");
    expect(doc.hasEditJournalCommit({ journalId: "j", sequence: 1 })).toBe(
      true,
    );
    await doc.close();
  });

  it("is unavailable on ordinary browser SyncDocs", async () => {
    const doc = await open();
    await expect(doc.commitExactPatch([])).rejects.toThrow(
      "trusted server-owned SyncDoc",
    );
    await doc.close();
  });
});
