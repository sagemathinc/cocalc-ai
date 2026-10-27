/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Saves (upsert) and removals of one credential serialize on the selector's
// advisory lock, so an upserted selector ends with exactly one active row and
// a removal that runs last leaves no stored copy. This needs concurrent
// transactions, hence a real PostgreSQL (PGlite has a single connection); it
// skips itself when the server binaries are not installed.

import {
  postgresBinDir,
  startRealPostgres,
  waitForLockWaiters,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";
import { uuid } from "@cocalc/util/misc";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, value: string) => value,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value,
  }),
}));

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

describeRealPostgres("external credential save and removal concurrency", () => {
  let pg: RealPostgres;
  let getPool: any;
  let store: typeof import("./store");

  beforeAll(async () => {
    pg = startRealPostgres("external_credentials_concurrency_test");
    getPool = (await import("@cocalc/database/pool")).default;
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    await syncSchema({ external_credentials: SCHEMA.external_credentials });
    store = await import("./store");
  }, 120_000);

  afterAll(async () => {
    try {
      await getPool?.().end();
    } finally {
      pg?.stop();
    }
  });

  const selectorFor = (owner_account_id: string) => ({
    provider: "openai",
    kind: "api-key",
    scope: "account" as const,
    owner_account_id,
  });

  const rows = async (owner_account_id: string) =>
    (
      await getPool().query(
        `SELECT id, encrypted_payload, revoked FROM external_credentials
         WHERE owner_account_id=$1 ORDER BY created`,
        [owner_account_id],
      )
    ).rows;

  // Hold the selector's lock in a separate transaction, run `queue` (which
  // starts the operations that must wait for it), then release it and wait
  // for them. Cleanup runs even if an assertion fails, so no connection or
  // PostgreSQL child is left behind.
  async function withSelectorLockHeld(
    selector: ReturnType<typeof selectorFor>,
    queue: (pending: Promise<unknown>[]) => Promise<void>,
  ): Promise<void> {
    const blocker = await getPool().connect();
    const pending: Promise<unknown>[] = [];
    let open = true;
    const release = async () => {
      if (!open) return;
      open = false;
      await blocker.query("COMMIT").catch(() => undefined);
    };
    const timeout = setTimeout(() => void release(), 10_000);
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        store.selectorLockKey(selector),
      ]);
      await queue(pending);
      await release();
      await Promise.all(pending);
    } finally {
      await release();
      await Promise.allSettled(pending);
      clearTimeout(timeout);
      blocker.release();
    }
  }

  it("saves held behind the lock all wait, and leave exactly one active row", async () => {
    const owner = uuid();
    const selector = selectorFor(owner);
    await withSelectorLockHeld(selector, async (pending) => {
      for (const payload of ["a", "b", "c"]) {
        pending.push(store.upsertExternalCredential({ selector, payload }));
      }
      // All three are blocked on the held lock: none has written yet.
      await waitForLockWaiters((sql) => getPool().query(sql), 3);
      expect(await rows(owner)).toEqual([]);
    });
    const active = (await rows(owner)).filter((row) => !row.revoked);
    expect(active).toHaveLength(1);
  });

  it("a removal queued after a save wins: nothing active, no payload left", async () => {
    const owner = uuid();
    const selector = selectorFor(owner);
    const { id } = await store.upsertExternalCredential({
      selector,
      payload: "one",
    });
    await withSelectorLockHeld(selector, async (pending) => {
      pending.push(
        store.upsertExternalCredential({ selector, payload: "two" }),
      );
      await waitForLockWaiters((sql) => getPool().query(sql), 1);
      pending.push(
        store.revokeExternalCredential({ id, owner_account_id: owner }),
      );
      await waitForLockWaiters((sql) => getPool().query(sql), 2);
    });
    const all = await rows(owner);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(id);
    expect(all[0].revoked).not.toBeNull();
    expect(all[0].encrypted_payload).toBeNull();
    expect(await store.getExternalCredential({ selector })).toBeUndefined();
  });
});
