/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  getProjectStopPolicy,
  getProjectStopState,
  listProjectStopPolicies,
  upsertProjectStopPolicy,
  upsertProjectStopState,
} from "./stop-policy";

describe("project stop policy sqlite", () => {
  const prevFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
  const project_id = "1fc5e846-547c-4c78-baa3-d0528685eea0";

  beforeEach(() => {
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (prevFilename == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = prevFilename;
    }
  });

  it("stores mirrored stop policy rows", () => {
    upsertProjectStopPolicy({
      project_id,
      owner_account_id: "owner-1",
      shared_compute_priority: 7,
      authoritative_last_edited_ms: 1234,
      policy_updated_ms: 2345,
      stop_override: "protect",
    });

    expect(getProjectStopPolicy(project_id)).toMatchObject({
      project_id,
      owner_account_id: "owner-1",
      shared_compute_priority: 7,
      authoritative_last_edited_ms: 1234,
      policy_updated_ms: 2345,
      stop_override: "protect",
    });
    expect(listProjectStopPolicies()).toHaveLength(1);
  });

  it("merges project stop state updates", () => {
    upsertProjectStopState({
      project_id,
      last_started_ms: 111,
      pressure_cooldown_until_ms: 222,
      last_decision_reason: "startup_protected",
    });
    upsertProjectStopState({
      project_id,
      last_pressure_stop_ms: 333,
      last_decision_pressure_zone: "pressure",
    });

    expect(getProjectStopState(project_id)).toMatchObject({
      project_id,
      last_started_ms: 111,
      pressure_cooldown_until_ms: 222,
      last_pressure_stop_ms: 333,
      last_decision_reason: "startup_protected",
      last_decision_pressure_zone: "pressure",
    });
  });

  it("allows explicitly clearing project stop state fields", () => {
    upsertProjectStopState({
      project_id,
      pressure_cooldown_until_ms: 222,
      last_decision_reason: "pressure_stop",
    });
    upsertProjectStopState({
      project_id,
      pressure_cooldown_until_ms: null,
      last_decision_reason: null,
    });

    expect(getProjectStopState(project_id)).toMatchObject({
      project_id,
      pressure_cooldown_until_ms: null,
      last_decision_reason: null,
    });
  });
});
