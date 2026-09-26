import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApiKeyFile, resolveApiKeyFileGlobals } from "./api-key-file";
import { applyAuthProfile } from "../../core/auth-config";

test("key-file snapshots isolate profile credentials and follow atomic rotation", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-key-file-"));
  const path = join(dir, "key");
  try {
    writeFileSync(path, "synthetic-first\n", { mode: 0o600 });
    const snapshot = resolveApiKeyFileGlobals({
      apiKeyFile: path,
      cookie: "human-cookie",
      bearer: "agent-token",
      hubPassword: "admin-secret",
      profile: "human",
    });
    assert.equal(snapshot.apiKey, "synthetic-first");
    assert.equal(snapshot.apiKeyFile, undefined);
    assert.equal(snapshot.cookie, undefined);
    assert.equal(snapshot.bearer, undefined);
    assert.equal(snapshot.hubPassword, undefined);
    assert.equal(snapshot.disableEnvAuthDefaults, true);
    assert.deepEqual(
      applyAuthProfile(snapshot, {
        profiles: { human: { cookie: "human-cookie" } },
      }).globals,
      snapshot,
    );
    writeFileSync(path + ".next", "synthetic-second", { mode: 0o600 });
    renameSync(path + ".next", path);
    assert.equal(
      resolveApiKeyFileGlobals({ apiKeyFile: path }).apiKey,
      "synthetic-second",
    );
    assert.equal(snapshot.apiKey, "synthetic-first");
    rmSync(path);
    assert.throws(
      () => resolveApiKeyFileGlobals({ apiKeyFile: path }),
      /unavailable/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("key-file snapshots reject ambiguous, public, malformed, and indirect providers", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-key-file-"));
  const path = join(dir, "key");
  try {
    writeFileSync(path, "synthetic", { mode: 0o600 });
    assert.throws(
      () => resolveApiKeyFileGlobals({ apiKeyFile: path, apiKey: "another" }),
      /either/,
    );
    symlinkSync(path, path + ".link");
    assert.throws(
      () => resolveApiKeyFileGlobals({ apiKeyFile: path + ".link" }),
      /unavailable/,
    );
    assert.throws(
      () => resolveApiKeyFileGlobals({ apiKeyFile: dir }),
      /regular/,
    );
    chmodSync(path, 0o644);
    assert.throws(
      () => resolveApiKeyFileGlobals({ apiKeyFile: path }),
      /private/,
    );
    chmodSync(path, 0o600);
    for (const text of ["", "x".repeat(4097), "two secrets"]) {
      writeFileSync(path, text);
      assert.throws(
        () => resolveApiKeyFileGlobals({ apiKeyFile: path }),
        /API key file/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential bytes remain bounded when the file grows after inspection", (t) => {
  const fs = require("node:fs") as typeof import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "api-key-growing-"));
  const path = join(dir, "key");
  try {
    writeFileSync(path, "x".repeat(8192), { mode: 0o600 });
    const originalStat = fs.fstatSync;
    t.mock.method(fs, "fstatSync", (fd: number) =>
      Object.assign(Object.create(originalStat(fd)), { size: 1 }),
    );
    const originalRead = fs.readSync;
    let total = 0;
    t.mock.method(
      fs,
      "readSync",
      (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        assert.ok(buffer.length <= 4097);
        const count = originalRead(fd, buffer, offset, length, position);
        total += count;
        return count;
      },
    );
    assert.throws(() => readApiKeyFile(path), /exceeds 4 KiB/);
    assert.equal(total, 4097);
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
