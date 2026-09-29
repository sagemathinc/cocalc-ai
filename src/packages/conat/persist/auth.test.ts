/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { assertHasWritePermission, isNormalizedStoragePath } from "./auth";

const ACCOUNT_ID = "00000000-1000-4000-8000-000000000001";
const SERVICE = "persist-test";
const SUBJECT = `${SERVICE}.account-${ACCOUNT_ID}`;

describe("persistent storage protocol paths", () => {
  it("confines a project socket's payload to its project storage", () => {
    const projectId = "00000000-1000-4000-8000-000000000002";
    const subject = `persist.project-${projectId}.server.shard.client`;
    expect(() =>
      assertHasWritePermission({
        subject,
        path: `projects/${projectId}/notebook`,
      }),
    ).not.toThrow();
    for (const path of [
      `accounts/${ACCOUNT_ID}/notebook`,
      `projects/${ACCOUNT_ID}/notebook`,
      `projects/${projectId}-other/notebook`,
      `projects/${projectId}/../${ACCOUNT_ID}/notebook`,
      "hub/notebook",
    ]) {
      expect(() => assertHasWritePermission({ subject, path })).toThrow();
    }
  });

  it("accepts canonical POSIX paths on every host platform", () => {
    expect(() =>
      assertHasWritePermission({
        subject: SUBJECT,
        path: `accounts/${ACCOUNT_ID}/account-feed`,
        service: SERVICE,
      }),
    ).not.toThrow();
  });

  it("rejects traversal", () => {
    expect(() =>
      assertHasWritePermission({
        subject: SUBJECT,
        path: `accounts/${ACCOUNT_ID}/folder/../account-feed`,
        service: SERVICE,
      }),
    ).toThrow("is not normalized");
  });

  it("treats backslashes according to host filename semantics", () => {
    const path = `accounts/${ACCOUNT_ID}/dko-[weird\\name]`;
    expect(isNormalizedStoragePath(path, "linux")).toBe(true);
    expect(isNormalizedStoragePath(path, "darwin")).toBe(true);
    expect(isNormalizedStoragePath(path, "browser")).toBe(true);
    expect(isNormalizedStoragePath(path, "win32")).toBe(false);
  });
});
