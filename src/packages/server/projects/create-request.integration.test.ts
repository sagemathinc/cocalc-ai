/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { before, after, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import type { ProjectControlCreateRequest } from "@cocalc/conat/inter-bay/api";
import {
  ensureProjectCreationReceiptSchema,
  hasProjectCreationReceipt,
  lockProjectCreation,
  projectCreationRequestHash,
  createWithReconciliation,
} from "./create-request";

beforeAll(async () => {
  await before({ noConat: true });
  await ensureProjectCreationReceiptSchema();
}, 30_000);
afterAll(after);

function request(): ProjectControlCreateRequest {
  const project_id = uuid();
  return {
    source_bay_id: "bay-2",
    operation_id: project_id,
    options: {
      project_id,
      account_id: uuid(),
      host_id: uuid(),
      title: "QA",
      start: false,
    },
  };
}

async function commit(
  r: ProjectControlCreateRequest,
  rollback = false,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockProjectCreation(client, r.options.project_id);
    const hash = projectCreationRequestHash(r);
    if (await hasProjectCreationReceipt(r, hash, client)) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      "INSERT INTO projects (project_id, users, creation_request_hash) VALUES ($1, $2, $3)",
      [
        r.options.project_id,
        { [r.options.account_id]: { group: "owner" } },
        hash,
      ],
    );
    await client.query(rollback ? "ROLLBACK" : "COMMIT");
    return !rollback;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

it("serializes simultaneous exact retries into one committed project", async () => {
  const r = request();
  const results = await Promise.all(Array.from({ length: 8 }, () => commit(r)));
  expect(results.filter(Boolean)).toHaveLength(1);
  const { rows } = await getPool().query(
    "SELECT project_id FROM projects WHERE project_id=$1",
    [r.options.project_id],
  );
  expect(rows).toHaveLength(1);
});

it("rolls back the receipt together with the project", async () => {
  const r = request();
  await commit(r, true);
  expect(
    await hasProjectCreationReceipt(r, projectCreationRequestHash(r)),
  ).toBe(false);
  expect(await commit(r)).toBe(true);
});

it("rejects mismatched retries and deleted projects without creating replacements", async () => {
  const r = request();
  await commit(r);
  await expect(
    commit({ ...r, options: { ...r.options, host_id: uuid() } }),
  ).rejects.toThrow("conflicts");
  await getPool().query(
    "UPDATE projects SET deleted=TRUE WHERE project_id=$1",
    [r.options.project_id],
  );
  await expect(commit(r)).rejects.toThrow("deleted");
});

it("canonicalizes key order and omitted undefined fields", () => {
  const r = request();
  expect(projectCreationRequestHash(r)).toBe(
    projectCreationRequestHash({
      options: { ...r.options, description: undefined },
      operation_id: r.operation_id,
      source_bay_id: r.source_bay_id,
    }),
  );
});

it("does not let one operation allocate a second project ID", () => {
  const r = request();
  expect(() =>
    projectCreationRequestHash({
      ...r,
      options: { ...r.options, project_id: uuid() },
    }),
  ).toThrow("invalid inter-bay project creation request");
});

it("does not replay project metadata after the creator loses access", async () => {
  const r = request();
  await commit(r);
  await getPool().query(
    "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
    [r.options.project_id],
  );
  await expect(commit(r)).rejects.toThrow("no longer accessible");
});

it.each(["missing", "unreachable"])(
  "reports unknown rather than failure when reconciliation is %s",
  async (mode) => {
    const r = request();
    const destination = {
      create: jest.fn(async () => {
        throw new Error("timeout");
      }),
      createStatus: jest.fn(async () => {
        if (mode === "unreachable") throw new Error("offline");
        return null;
      }),
    };
    await expect(
      createWithReconciliation(r, destination),
    ).rejects.toMatchObject({
      code: "project_create_unknown",
      project_id: r.options.project_id,
      operation_id: r.operation_id,
    });
    expect(destination.create).toHaveBeenCalledTimes(1);
    expect(destination.createStatus).toHaveBeenCalledWith(r);
  },
);
