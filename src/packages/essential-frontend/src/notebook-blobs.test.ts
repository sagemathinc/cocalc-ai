/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  createNotebookBlobResolver,
  isNotebookBlobReference,
  notebookBlobStoreName,
} from "./notebook-blobs";

test("uses the canonical Jupyter AKV name", () => {
  expect(notebookBlobStoreName("/home/user/spiral.ipynb")).toBe(
    "jupyter/home/user/spiral.ipynb",
  );
  expect(isNotebookBlobReference("a".repeat(40))).toBe(true);
  expect(isNotebookBlobReference("not-base64-or-sha1")).toBe(false);
});

test("resolves a bounded notebook blob from the project-scoped AKV", async () => {
  const close = jest.fn();
  const get = jest.fn(async () => new Uint8Array([1, 2, 3]));
  const akv = jest.fn(() => ({ close, get }));
  const resolver = createNotebookBlobResolver({
    client: { sync: { akv } } as any,
    path: "/home/user/a.ipynb",
    projectId: "project-a",
  });

  await expect(resolver.resolve("a".repeat(40))).resolves.toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(akv).toHaveBeenCalledWith({
    name: "jupyter/home/user/a.ipynb",
    project_id: "project-a",
  });
  resolver.close();
  expect(close).toHaveBeenCalled();
});
