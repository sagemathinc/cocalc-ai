/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
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
  defaultApiKey,
  managedConnectorCredentialFromEnv,
  readManagedConnectorKey,
  prepareManagedConnectorDaemonGlobals,
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
    assert.equal(
      defaultApiKey({ envKey: "ambient-key", managedConnector }),
      undefined,
    );
    assert.equal(
      defaultApiKey({
        explicitKey: "explicit-key",
        envKey: "ambient-key",
        managedConnector,
      }),
      "explicit-key",
    );
    assert.equal(defaultApiKey({ envKey: "ambient-key" }), "ambient-key");
    assert.equal(apiKeyForProject({ managedConnector }, SOURCE), undefined);
    assert.equal(apiKeyForProject({ managedConnector }, TARGET), "scoped-key");
    assert.equal(apiKeyForProject({ managedConnector }), "scoped-key");
    assert.equal(
      apiKeyForProject({ apiKey: "explicit-key", managedConnector }, TARGET),
      "explicit-key",
    );
    rmSync(keyFile);
    assert.equal(apiKeyForProject({ managedConnector }, SOURCE), undefined);
    assert.throws(
      () => apiKeyForProject({ managedConnector }, TARGET),
      /connector credential is unavailable/,
    );
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

test("daemon snapshots rotate target authority without removing source access", () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-snapshot-"));
  const keyFile = join(dir, "key");
  const request = {
    managedConnector: {
      keyFile,
      sourceProjectId: SOURCE,
      keySnapshot: "must-not-be-trusted",
    },
  };
  try {
    writeFileSync(keyFile, "first", { mode: 0o600 });
    const first = prepareManagedConnectorDaemonGlobals(request);
    assert.equal(apiKeyForProject(first, TARGET), "first");
    assert.equal(apiKeyForProject(first, SOURCE), undefined);
    writeFileSync(keyFile, "second");
    const second = prepareManagedConnectorDaemonGlobals(request);
    assert.equal(apiKeyForProject(second, TARGET), "second");
    assert.equal(apiKeyForProject(first, TARGET), "first");
    rmSync(keyFile);
    const absent = prepareManagedConnectorDaemonGlobals(request);
    assert.equal(apiKeyForProject(absent, SOURCE), undefined);
    assert.throws(() => apiKeyForProject(absent, TARGET), /unavailable/);
    assert.throws(() => apiKeyForProject(absent), /unavailable/);
    assert.throws(
      () =>
        prepareManagedConnectorDaemonGlobals({
          managedConnector: { keyFile, sourceProjectId: "invalid" },
        }),
      /valid source project/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "managed credential FIFO rejection cannot block command admission",
  { skip: process.platform === "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "cocalc-connector-fifo-"));
    const path = join(dir, "key");
    try {
      execFileSync("mkfifo", ["-m", "600", path]);
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `
      const {readManagedConnectorKey}=require(${JSON.stringify(require.resolve("./managed-connector-auth"))});
      try {readManagedConnectorKey(${JSON.stringify(path)});process.exit(1);}
      catch(error) {if(!/credential is unavailable or file is invalid/.test(error.message))process.exit(2);}
    `,
        ],
        { timeout: 3000, encoding: "utf8" },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
