import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  acquireStorageReservation,
  getActiveStorageReservationSummary,
} from "../storage-reservations";
import { initSqlite } from "./init";

describe("project-host sqlite init", () => {
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-sqlite-"),
    );
    dbPath = path.join(tempDir, "sqlite.db");
    process.env.COCALC_LITE_SQLITE_FILENAME = dbPath;
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.COCALC_LITE_SQLITE_FILENAME;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("clears stale active storage reservations on startup", async () => {
    initSqlite();
    await acquireStorageReservation({
      kind: "oci-pull",
      estimated_bytes: 4 * 1024 ** 3,
      current_storage: {
        disk_available_conservative_bytes: 64 * 1024 ** 3,
      },
    });
    expect(getActiveStorageReservationSummary().count).toBe(1);

    closeDatabase();

    initSqlite();
    expect(getActiveStorageReservationSummary().count).toBe(0);
  });
});
