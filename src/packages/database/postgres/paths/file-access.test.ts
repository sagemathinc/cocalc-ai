/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";

import { get_file_access, log_file_access } from "./file-access";
import type { PostgreSQL } from "../types";

describe("file access methods", () => {
  const database: PostgreSQL = db();

  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterAll(async () => {
    await testCleanup();
  });

  describe("log_file_access and get_file_access", () => {
    it("logs file access and retrieves it", async () => {
      const project_id = uuid();
      const account_id = uuid();
      const filename = `test_file_${Date.now()}.txt`;

      await log_file_access(database, {
        project_id,
        account_id,
        filename,
      });

      const results = await get_file_access(database, {
        project_id,
        account_id,
        filename,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      const foundEntry = results.find(
        (r) =>
          r.project_id === project_id &&
          r.account_id === account_id &&
          r.filename === filename,
      );
      expect(foundEntry).toBeDefined();
      expect(foundEntry!.time).toBeInstanceOf(Date);
    });

    it("filters by project_id", async () => {
      const project_id = uuid();
      const account_id = uuid();
      const filename = `test_filter_project_${Date.now()}.txt`;

      await log_file_access(database, {
        project_id,
        account_id,
        filename,
      });

      const results = await get_file_access(database, { project_id });

      expect(results.length).toBeGreaterThanOrEqual(1);
      results.forEach((entry) => {
        expect(entry.project_id).toBe(project_id);
      });
    });

    it("filters by account_id", async () => {
      const project_id = uuid();
      const account_id = uuid();
      const filename = `test_filter_account_${Date.now()}.txt`;

      await log_file_access(database, {
        project_id,
        account_id,
        filename,
      });

      const results = await get_file_access(database, { account_id });

      expect(results.length).toBeGreaterThanOrEqual(1);
      results.forEach((entry) => {
        expect(entry.account_id).toBe(account_id);
      });
    });

    it("filters by time range", async () => {
      const project_id = uuid();
      const account_id = uuid();
      const filename = `test_time_range_${Date.now()}.txt`;

      const start = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
      const end = new Date(Date.now() + 1000 * 60 * 60); // 1 hour from now

      await log_file_access(database, {
        project_id,
        account_id,
        filename,
      });

      const results = await get_file_access(database, {
        start,
        end,
        filename,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      results.forEach((entry) => {
        expect(entry.time.getTime()).toBeGreaterThanOrEqual(start.getTime());
        expect(entry.time.getTime()).toBeLessThanOrEqual(end.getTime());
      });
    });

    it("throttles duplicate log_file_access calls", async () => {
      const project_id = uuid();
      const account_id = uuid();
      const filename = `test_throttle_${Date.now()}.txt`;

      // First call should succeed
      await log_file_access(database, {
        project_id,
        account_id,
        filename,
      });

      const before = await get_file_access(database, {
        project_id,
        account_id,
        filename,
      });
      const countBefore = before.length;

      // Second call within 60s should be throttled
      await log_file_access(database, {
        project_id,
        account_id,
        filename,
      });

      const after = await get_file_access(database, {
        project_id,
        account_id,
        filename,
      });

      // Count should be the same (second call was throttled)
      expect(after.length).toBe(countBefore);
    });

    it("returns empty array when no matches found", async () => {
      const nonexistent_project = uuid();

      const results = await get_file_access(database, {
        project_id: nonexistent_project,
      });

      expect(results).toEqual([]);
    });
  });
});
