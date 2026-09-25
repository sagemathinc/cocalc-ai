/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  chmodSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  apiKeyForProject,
  managedConnectorCredentialFromEnv,
  readManagedConnectorKey,
} from "./managed-connector-auth";

const SOURCE = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";

test("a managed key is selected only for account and other-project work", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-connector-cli-"));
  try {
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "scoped-key\n", { mode: 0o600 });
    const managedConnector = managedConnectorCredentialFromEnv({
      COCALC_CONNECTOR_API_KEY_FILE: keyFile,
      COCALC_PROJECT_ID: SOURCE,
    });
    assert.deepEqual(managedConnector, {
      keyFile,
      sourceProjectId: SOURCE,
    });
    assert.equal(apiKeyForProject({ managedConnector }, SOURCE), undefined);
    assert.equal(apiKeyForProject({ managedConnector }, TARGET), "scoped-key");
    assert.equal(apiKeyForProject({ managedConnector }), "scoped-key");
    assert.equal(
      apiKeyForProject({ apiKey: "explicit-key", managedConnector }, TARGET),
      "explicit-key",
    );
    rmSync(keyFile);
    assert.equal(apiKeyForProject({ managedConnector }, SOURCE), undefined);
    assert.throws(() => apiKeyForProject({ managedConnector }, TARGET));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed credential provider rejects exposed files and symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-connector-cli-"));
  try {
    const keyFile = join(dir, "key");
    const link = join(dir, "link");
    writeFileSync(keyFile, "scoped-key\n", { mode: 0o600 });
    symlinkSync(keyFile, link);
    assert.throws(() => readManagedConnectorKey(link));
    chmodSync(keyFile, 0o644);
    assert.throws(() => readManagedConnectorKey(keyFile), /file is invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
