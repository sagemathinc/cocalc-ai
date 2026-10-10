/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// For tests that mock "@cocalc/database/settings/secret-settings" with a
// fixed key instead of reading the site master key files:
//
//   jest.mock("@cocalc/database/settings/secret-settings", () =>
//     require("@cocalc/database/settings/secret-settings-test-mock")
//       .secretSettingsMock(Buffer.alloc(32, 1)),
//   );

import type { DerivedSiteKey } from "@cocalc/util/master-key-lifecycle";
import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
  isEncryptedSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";

export function secretSettingsMock(key: Buffer, retired: Buffer[] = []) {
  const keys: DerivedSiteKey[] = [
    { id: "smk_test_active", role: "active", key },
    ...retired.map((other, i) => ({
      id: `smk_test_retired_${i}`,
      role: "retired" as const,
      key: other,
    })),
  ];
  const decryptWithKey = (name: string, value: string) => {
    let firstError: unknown;
    for (const candidate of keys) {
      try {
        return {
          value: decryptSecretSettingValue(name, value, candidate.key),
          key: candidate,
        };
      } catch (err) {
        firstError ??= err;
      }
    }
    throw firstError;
  };
  return {
    __esModule: true,
    getSecretSettingsKey: async () => key,
    getSecretSettingsKeys: async () => keys,
    secretSettingKeyId: () => undefined,
    secretSettingsHmacCandidates: async (digest: (key: Buffer) => string) => [
      ...new Set(keys.map((candidate) => digest(candidate.key))),
    ],
    encryptSecretStorageValue: async (name: string, value: string) =>
      value && !isEncryptedSecretSettingValue(value)
        ? encryptSecretSettingValue(name, value, key, keys[0].id)
        : value,
    decryptSecretStorageValueWithKey: async (name: string, value: string) =>
      decryptWithKey(name, value),
    decryptSecretStorageValue: async (name: string, value: string) => {
      if (!value) return { value: "", needsMigration: false };
      if (!isEncryptedSecretSettingValue(value)) {
        return { value, needsMigration: true };
      }
      const result = decryptWithKey(name, value);
      return {
        value: result.value,
        needsMigration: result.key.role === "retired",
      };
    },
  };
}
