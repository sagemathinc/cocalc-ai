/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What the hub records about a host's backup profile after a hard delete
// comes from this mapping: only a host that names one of the three outcomes
// is believed, so an older host (no profile) or a garbled answer never reads
// as "removed".

const invalidateBackupConfigMock = jest.fn();
const routedClientMock = jest.fn(async (_opts: any) => ({
  invalidateBackupConfig: (opts: any) => invalidateBackupConfigMock(opts),
}));

jest.mock("./client", () => ({
  getRoutedHostControlClient: (opts: any) => routedClientMock(opts),
}));

import { invalidateProjectBackupConfigOnHostChecked } from "./control";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const HOST = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  invalidateBackupConfigMock.mockReset();
  routedClientMock.mockClear();
});

function check() {
  return invalidateProjectBackupConfigOnHostChecked({
    project_id: PROJECT,
    host_id: HOST,
  });
}

it("asks the project's host, with a timeout", async () => {
  invalidateBackupConfigMock.mockResolvedValue({ ok: true });
  await check();
  expect(routedClientMock).toHaveBeenCalledWith({
    host_id: HOST,
    timeout: 15_000,
  });
  expect(invalidateBackupConfigMock).toHaveBeenCalledWith({
    project_id: PROJECT,
  });
});

it.each(["removed", "absent", "failed"])(
  "passes a host's %s through",
  async (profile) => {
    invalidateBackupConfigMock.mockResolvedValue({ ok: true, profile });
    await expect(check()).resolves.toEqual({ profile });
  },
);

it.each([
  ["an older host's bare ok", { ok: true }],
  ["an unknown profile", { ok: true, profile: "bogus" }],
  ["a non-string profile", { ok: true, profile: { removed: true } }],
  ["an empty answer", undefined],
  ["a null answer", null],
])("reports nothing for %s, never removed", async (_label, answer) => {
  invalidateBackupConfigMock.mockResolvedValue(answer);
  await expect(check()).resolves.toEqual({});
});

it("lets a host's error through for the caller to record", async () => {
  invalidateBackupConfigMock.mockRejectedValue(new Error("timeout"));
  await expect(check()).rejects.toThrow("timeout");
});
