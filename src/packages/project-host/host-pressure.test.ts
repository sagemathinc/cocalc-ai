/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { _test } from "./host-pressure";

const { buildStopCandidates, classifyHostPressure } = _test;

describe("host pressure controller helpers", () => {
  it("classifies memory pressure zones", () => {
    expect(
      classifyHostPressure({
        memory_used_percent: 50,
        memory_available_bytes: 8 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "normal" });
    expect(
      classifyHostPressure({
        memory_used_percent: 86,
        memory_available_bytes: 8 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "observe" });
    expect(
      classifyHostPressure({
        memory_used_percent: 91,
        memory_available_bytes: 8 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "pressure" });
    expect(
      classifyHostPressure({
        memory_used_percent: 91,
        memory_available_bytes: 400 * 1024 ** 2,
      }),
    ).toMatchObject({ zone: "emergency" });
  });

  it("ranks lower priority and older activity first", () => {
    const now = 2_000_000;
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
      projects: [
        {
          project_id: "proj-high",
          state: "running",
          run_quota: { memory_limit: 4000 },
        },
        {
          project_id: "proj-low",
          state: "running",
          run_quota: { memory_limit: 1000 },
        },
        {
          project_id: "proj-old",
          state: "running",
          run_quota: { memory_limit: 500 },
        },
      ],
      policies: new Map([
        [
          "proj-high",
          {
            project_id: "proj-high",
            owner_account_id: "owner-1",
            shared_compute_priority: 5,
            authoritative_last_edited_ms: 1900,
            policy_updated_ms: 1900,
            stop_override: "default",
          },
        ],
        [
          "proj-low",
          {
            project_id: "proj-low",
            owner_account_id: "owner-2",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1950,
            policy_updated_ms: 1950,
            stop_override: "default",
          },
        ],
        [
          "proj-old",
          {
            project_id: "proj-old",
            owner_account_id: "owner-3",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1200,
            policy_updated_ms: 1200,
            stop_override: "default",
          },
        ],
      ]),
      getStopState: () => undefined,
    });

    expect(candidates.map((candidate) => candidate.project_id)).toEqual([
      "proj-old",
      "proj-low",
      "proj-high",
    ]);
  });

  it("excludes startup-protected and protected projects in pressure", () => {
    const now = 2_000_000;
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
      projects: [
        { project_id: "proj-starting", state: "running" },
        { project_id: "proj-protected", state: "running" },
        { project_id: "proj-default", state: "running" },
      ],
      policies: new Map([
        [
          "proj-starting",
          {
            project_id: "proj-starting",
            owner_account_id: "owner-1",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1000,
            policy_updated_ms: 1000,
            stop_override: "default",
          },
        ],
        [
          "proj-protected",
          {
            project_id: "proj-protected",
            owner_account_id: "owner-2",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1000,
            policy_updated_ms: 1000,
            stop_override: "protect",
          },
        ],
      ]),
      getStopState: (project_id) =>
        project_id === "proj-starting"
          ? {
              project_id,
              last_started_ms: now - 60_000,
            }
          : undefined,
    });

    expect(candidates.map((candidate) => candidate.project_id)).toEqual([
      "proj-default",
    ]);
  });

  it("allows emergency ranking to bypass startup protection and protect override", () => {
    const now = 2_000_000;
    const candidates = buildStopCandidates({
      zone: "emergency",
      now,
      projects: [
        { project_id: "proj-default", state: "running" },
        { project_id: "proj-starting", state: "starting" },
        { project_id: "proj-protected", state: "running" },
      ],
      policies: new Map([
        [
          "proj-protected",
          {
            project_id: "proj-protected",
            owner_account_id: "owner-2",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1000,
            policy_updated_ms: 1000,
            stop_override: "protect",
          },
        ],
      ]),
      getStopState: (project_id) =>
        project_id === "proj-starting"
          ? {
              project_id,
              last_started_ms: now - 60_000,
            }
          : undefined,
    });

    expect(candidates.map((candidate) => candidate.project_id)).toEqual([
      "proj-default",
      "proj-starting",
      "proj-protected",
    ]);
  });
});
