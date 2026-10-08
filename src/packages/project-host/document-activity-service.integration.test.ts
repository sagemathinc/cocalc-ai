/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after, connect, wait } from "@cocalc/backend/conat/test/setup";
import { dstream } from "@cocalc/conat/sync/dstream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { syncdbPath } from "@cocalc/util/jupyter/names";
import {
  getFileUseTimes,
  markFile,
} from "@cocalc/conat/project/document-activity";
import { initProjectDocumentActivityService } from "./document-activity-service";

// Only control-plane membership is synthetic; RPC and persisted streams are real.
jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: () => ({
    users: {
      "00000000-0000-4000-8000-000000000001": { group: "owner" },
      "00000000-0000-4000-8000-000000000002": { group: "collaborator" },
    },
  }),
}));

jest.setTimeout(30_000);
beforeAll(before);
afterAll(after);

it("exports persisted notebook patch times alongside account-filtered visible-path access over RPC", async () => {
  const teacher = "00000000-0000-4000-8000-000000000001";
  const student = "00000000-0000-4000-8000-000000000002";
  const project_id = "11111111-1111-4111-8111-111111111111";
  const path = "lectures/example.ipynb";
  const host = connect();
  const browser = connect();
  const service = await initProjectDocumentActivityService(host);
  try {
    // Seed the same persistent stream used by the notebook's sync document.
    const patches = await dstream({
      client: browser,
      project_id,
      name: patchesStreamName({ path: syncdbPath(path) }),
      noInventory: true,
      noAutosave: true,
    });
    let editTimes: (number | undefined)[];
    try {
      patches.publish({ synthetic: "notebook edit" });
      await patches.save();
      await wait({ until: () => patches.times().length === 1 });
      editTimes = patches.times().map((t) => t?.valueOf());
      expect(editTimes).toHaveLength(1);
      expect(editTimes.every(Number.isFinite)).toBe(true);
    } finally {
      await patches.close();
    }

    await markFile({
      client: browser,
      account_id: student,
      project_id,
      path,
      action: "open",
    });
    await markFile({
      client: browser,
      account_id: teacher,
      project_id,
      path,
      action: "edit",
    });
    await markFile({
      client: browser,
      account_id: student,
      project_id,
      path: "other.ipynb",
      action: "open",
    });
    const result = await getFileUseTimes({
      client: browser,
      account_id: teacher,
      project_id,
      path,
      target_account_id: student,
      access_times: true,
      edit_times: true,
    });
    expect(result.edit_times).toEqual(editTimes!);
    expect(result.access_times).toHaveLength(1);
    expect(result.access_times!.every(Number.isFinite)).toBe(true);
    expect(result.target_account_id).toBe(student);

    const absent = await getFileUseTimes({
      client: browser,
      account_id: teacher,
      project_id,
      path: "never-opened.ipynb",
      target_account_id: student,
      access_times: true,
      edit_times: true,
    });
    expect(absent.access_times).toEqual([]);
    expect(absent.edit_times).toEqual([]);
  } finally {
    await service.close();
  }
});

it("finds absolute-path notebook history and access when asked with a home-relative path", async () => {
  // Browsers open the syncdb and record activity under /home/user/...; the
  // course export asks with home-relative paths (support #20952/#20955).
  const teacher = "00000000-0000-4000-8000-000000000001";
  const student = "00000000-0000-4000-8000-000000000002";
  const project_id = "11111111-1111-4111-8111-111111111111";
  const relative = "lectures/absolute-history.ipynb";
  const absolute = `/home/user/${relative}`;
  const host = connect();
  const browser = connect();
  const service = await initProjectDocumentActivityService(host);
  try {
    const patches = await dstream({
      client: browser,
      project_id,
      name: patchesStreamName({ path: syncdbPath(absolute) }),
      noInventory: true,
      noAutosave: true,
    });
    let editTimes: (number | undefined)[];
    try {
      patches.publish({ synthetic: "notebook edit" });
      await patches.save();
      await wait({ until: () => patches.times().length === 1 });
      editTimes = patches.times().map((t) => t?.valueOf());
    } finally {
      await patches.close();
    }
    await markFile({
      client: browser,
      account_id: student,
      project_id,
      path: absolute,
      action: "open",
    });
    const result = await getFileUseTimes({
      client: browser,
      account_id: teacher,
      project_id,
      path: relative,
      target_account_id: student,
      access_times: true,
      edit_times: true,
    });
    expect(result.edit_times).toEqual(editTimes!);
    expect(result.access_times).toHaveLength(1);
  } finally {
    await service.close();
  }
});
