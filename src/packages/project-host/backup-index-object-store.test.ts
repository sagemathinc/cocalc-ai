/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectBackupIndexStoreConfig } from "@cocalc/conat/hub/api/hosts";
import {
  buildBackupIndexObjectKey,
  downloadBackupIndexObject,
  uploadBackupIndexObject,
} from "./backup-index-object-store";

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
  let originalFetch: typeof fetch | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cocalc-backup-index-store-test-"));
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    global.fetch = originalFetch as typeof fetch;
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
    let uploadedBody = Buffer.alloc(0);
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = init.body as AsyncIterable<Buffer>;
        const chunks: Buffer[] = [];
        for await (const chunk of body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        uploadedBody = Buffer.concat(chunks);
        return new Response(null, { status: 200 });
      }
      return new Response(uploadedBody, { status: 200 });
    }) as typeof fetch;

    const uploaded = await uploadBackupIndexObject({
      config,
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
      backup_id: "backup-123",
      input_path: inputPath,
    });

    expect(uploaded.object_bytes).toBeGreaterThan(0);
    expect(uploaded.sqlite_bytes).toBe((await readFile(inputPath)).byteLength);
    expect(uploaded.sha256).toHaveLength(64);

    await downloadBackupIndexObject({
      config,
      object_key: uploaded.object_key,
      sha256: uploaded.sha256,
      output_path: outputPath,
    });

    expect(await readFile(outputPath, "utf8")).toBe("sqlite-test-payload");
  });
});
