/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectBackupIndexStoreConfig } from "@cocalc/conat/hub/api/hosts";
import { getR2ObjectToFile, putR2ObjectFromFile } from "@cocalc/backend/r2";
import {
  buildBackupIndexObjectKey,
  downloadBackupIndexObject,
  uploadBackupIndexObject,
} from "./backup-index-object-store";

jest.mock(
  "@cocalc/backend/r2",
  () => ({
    __esModule: true,
    putR2ObjectFromFile: jest.fn(),
    getR2ObjectToFile: jest.fn(),
  }),
  { virtual: true },
);

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: factory,
    getLogger: factory,
  };
});

describe("backup index object store", () => {
  const config: ProjectBackupIndexStoreConfig = {
    kind: "r2-object-store",
    endpoint: "https://example.r2.cloudflarestorage.com",
    bucket: "bucket-1",
    access_key_id: "access",
    secret_access_key: "secret",
    key_prefix: "project-backup-index/v1",
    compression: "gzip",
  };

  let tempDir: string;
  let objectBodies: Map<string, Buffer>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cocalc-backup-index-store-test-"));
    objectBodies = new Map();
    (putR2ObjectFromFile as jest.Mock).mockImplementation(
      async ({ key, filePath }: { key: string; filePath: string }) => {
        objectBodies.set(key, await readFile(filePath));
      },
    );
    (getR2ObjectToFile as jest.Mock).mockImplementation(
      async ({ key, outputPath }: { key: string; outputPath: string }) => {
        const body = objectBodies.get(key);
        if (body == null) {
          throw new Error(`missing object ${key}`);
        }
        await writeFile(outputPath, body);
        return {
          sha256: createHash("sha256").update(body).digest("hex"),
          bytes: body.length,
        };
      },
    );
  });

  afterEach(async () => {
    jest.resetAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("builds a stable object key", () => {
    expect(
      buildBackupIndexObjectKey({
        config,
        project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
        backup_id: "backup-123",
      }),
    ).toBe(
      "project-backup-index/v1/83/83aefe84-6bcc-49fd-b4c7-67a1831efcf7/backup-backup-123.sqlite.gz",
    );
  });

  it("uploads and downloads a compressed sqlite sidecar", async () => {
    const inputPath = join(tempDir, "input.sqlite");
    const outputPath = join(tempDir, "output.sqlite");
    await writeFile(inputPath, "sqlite-test-payload", "utf8");

    const uploaded = await uploadBackupIndexObject({
      config,
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
      backup_id: "backup-123",
      input_path: inputPath,
    });

    expect(uploaded.object_bytes).toBeGreaterThan(0);
    expect(uploaded.sqlite_bytes).toBe((await readFile(inputPath)).byteLength);
    expect(uploaded.sha256).toHaveLength(64);
    expect(putR2ObjectFromFile).toHaveBeenCalled();

    await downloadBackupIndexObject({
      config,
      object_key: uploaded.object_key,
      sha256: uploaded.sha256,
      output_path: outputPath,
    });

    expect(await readFile(outputPath, "utf8")).toBe("sqlite-test-payload");
    expect(getR2ObjectToFile).toHaveBeenCalled();
  });
});
