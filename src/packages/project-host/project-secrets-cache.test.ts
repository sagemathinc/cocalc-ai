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
    ).toEqual(["API_KEY"]);

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
        entries: [{ name: "TOKEN", encrypted_value, value_bytes: 10 }],
      },
    });
    resetProjectSecretsCacheKeyForTesting();

    expect(getCachedProjectSecrets(project_id)).toHaveLength(1);
    expect(getCachedProjectSecretsForRuntime({ project_id })).toBeUndefined();
  });
});
