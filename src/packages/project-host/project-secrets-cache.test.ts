/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import { encryptProjectSecretValue } from "@cocalc/util/project-secrets";
import {
  getCachedProjectSecretsForRuntime,
  resetProjectSecretsCacheKeyForTesting,
  syncProjectSecretsCache,
} from "./project-secrets-cache";
import { getCachedProjectSecrets } from "./sqlite/project-secrets";

describe("project secrets runtime cache", () => {
  const env = { ...process.env };
  const project_id = "624103b4-a08d-435e-8b83-38ebc5d03366";

  beforeEach(() => {
    process.env = { ...env };
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
    resetProjectSecretsCacheKeyForTesting();
  });

  afterEach(() => {
    closeDatabase();
    resetProjectSecretsCacheKeyForTesting();
    process.env = env;
  });

  it("stores encrypted values locally and decrypts them from the in-memory key", () => {
    const key = Buffer.alloc(32, 9);
    const encrypted_value = encryptProjectSecretValue({
      project_id,
      name: "API_KEY",
      value: "secret",
      key,
    });

    expect(
      syncProjectSecretsCache({
        project_id,
        cache: {
          key_base64: key.toString("base64"),
          generation: 1,
          entries: [
            {
              name: "API_KEY",
              encrypted_value,
              value_bytes: 6,
              updated_at: "2026-05-13T00:00:00.000Z",
            },
          ],
        },
      }),
    ).toEqual({
      accepted: true,
      secret_names: ["API_KEY"],
      cached_generation: 1,
      materialized_generation: 0,
    });

    const rows = getCachedProjectSecrets(project_id);
    expect(rows).toEqual([
      expect.objectContaining({
        project_id,
        name: "API_KEY",
        value_bytes: 6,
        encrypted_value,
      }),
    ]);
    expect(rows[0].encrypted_value.data_base64).not.toBe(
      Buffer.from("secret", "utf8").toString("base64"),
    );
    expect(getCachedProjectSecretsForRuntime({ project_id })).toEqual({
      API_KEY: "secret",
    });
  });

  it("fails closed when the host has cached ciphertext but no in-memory key", () => {
    const key = Buffer.alloc(32, 10);
    const encrypted_value = encryptProjectSecretValue({
      project_id,
      name: "TOKEN",
      value: "top-secret",
      key,
    });

    syncProjectSecretsCache({
      project_id,
      cache: {
        key_base64: key.toString("base64"),
        generation: 1,
        entries: [{ name: "TOKEN", encrypted_value, value_bytes: 10 }],
      },
    });
    resetProjectSecretsCacheKeyForTesting();

    expect(getCachedProjectSecrets(project_id)).toHaveLength(1);
    expect(getCachedProjectSecretsForRuntime({ project_id })).toBeUndefined();
  });

  it("does not let an out-of-order generation roll cached secrets backward", () => {
    const key = Buffer.alloc(32, 11);
    const encryptedNew = encryptProjectSecretValue({
      project_id,
      name: "TOKEN",
      value: "new",
      key,
    });
    const encryptedOld = encryptProjectSecretValue({
      project_id,
      name: "TOKEN",
      value: "old",
      key,
    });
    syncProjectSecretsCache({
      project_id,
      cache: {
        key_base64: key.toString("base64"),
        generation: 2,
        entries: [
          { name: "TOKEN", encrypted_value: encryptedNew, value_bytes: 3 },
        ],
      },
    });

    expect(
      syncProjectSecretsCache({
        project_id,
        cache: {
          key_base64: key.toString("base64"),
          generation: 1,
          entries: [
            { name: "TOKEN", encrypted_value: encryptedOld, value_bytes: 3 },
          ],
        },
      }),
    ).toEqual({
      accepted: false,
      secret_names: ["TOKEN"],
      cached_generation: 2,
      materialized_generation: 0,
    });
    expect(getCachedProjectSecretsForRuntime({ project_id })).toEqual({
      TOKEN: "new",
    });
  });

  it("assigns local generations to snapshots from legacy hubs", () => {
    const key = Buffer.alloc(32, 12);
    const encrypted_value = encryptProjectSecretValue({
      project_id,
      name: "TOKEN",
      value: "legacy",
      key,
    });
    const legacyCache = {
      key_base64: key.toString("base64"),
      entries: [{ name: "TOKEN", encrypted_value, value_bytes: 6 }],
    };

    expect(
      syncProjectSecretsCache({
        project_id,
        cache: legacyCache as any,
      }),
    ).toEqual(
      expect.objectContaining({ accepted: true, cached_generation: 1 }),
    );
    expect(
      syncProjectSecretsCache({
        project_id,
        cache: legacyCache as any,
      }),
    ).toEqual(
      expect.objectContaining({ accepted: true, cached_generation: 2 }),
    );
  });

  it("still decrypts values cached under the previous key after a key rotation", () => {
    const other_project_id = "b8a1f0c2-5d1e-4f37-9a52-1c6e0d4f7a19";
    const oldKey = Buffer.alloc(32, 21);
    const newKey = Buffer.alloc(32, 22);
    const sync = (id: string, key: Buffer, value: string) =>
      syncProjectSecretsCache({
        project_id: id,
        cache: {
          key_base64: key.toString("base64"),
          generation: 1,
          entries: [
            {
              name: "TOKEN",
              encrypted_value: encryptProjectSecretValue({
                project_id: id,
                name: "TOKEN",
                value,
                key,
              }),
              value_bytes: value.length,
            },
          ],
        },
      });
    sync(project_id, oldKey, "before");
    // Another project syncs after the rotation; this one has not yet.
    sync(other_project_id, newKey, "after");

    expect(getCachedProjectSecretsForRuntime({ project_id })).toEqual({
      TOKEN: "before",
    });
    expect(
      getCachedProjectSecretsForRuntime({ project_id: other_project_id }),
    ).toEqual({ TOKEN: "after" });
  });
});
