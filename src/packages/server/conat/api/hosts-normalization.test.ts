/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parseRow } from "./hosts-normalization";

describe("parseRow bootstrap lifecycle normalization", () => {
  it("rewrites stale bootstrap desired bundle versions from current runtime targets", () => {
    const host = parseRow(
      {
        id: "host-1",
        name: "host-1",
        status: "running",
        version: "1776559164732",
        region: "us-west3",
        metadata: {
          software: {
            project_host: "1776559164732",
            project_bundle: "1776560093917",
            tools: "1775834120905",
          },
          bootstrap: {
            status: "done",
            updated_at: "2026-04-19T02:08:00.000Z",
            message: "Host software reconciled",
          },
          bootstrap_lifecycle: {
            desired_recorded_at: "2026-04-19T02:07:17.000Z",
            installed_recorded_at: "2026-04-19T02:07:25.000Z",
            summary_status: "in_sync",
            summary_message: "desired and installed software are aligned",
            drift_count: 0,
            items: [
              {
                key: "project_host_bundle",
                label: "Project host bundle",
                status: "match",
                desired: "1776557040637",
                installed: "1776559164732",
                message: "installed bundle is newer than desired",
              },
              {
                key: "project_bundle",
                label: "Project bundle",
                status: "match",
                desired: "1776556035748",
                installed: "1776560093917",
                message: "installed bundle is newer than desired",
              },
              {
                key: "tools_bundle",
                label: "Tools bundle",
                status: "match",
                desired: "1775834120905",
                installed: "1775834120905",
              },
            ],
          },
        },
      },
      {
        runtime_desired_artifacts: {
          project_host: "1776559164732",
          project_bundle: "1776560093917",
          tools: "1775834120905",
          updated_at: "2026-04-19T02:07:52.704Z",
        },
      },
    );

    expect(host.bootstrap_lifecycle?.desired_recorded_at).toBe(
      "2026-04-19T02:07:52.704Z",
    );
    expect(host.bootstrap_lifecycle?.summary_status).toBe("in_sync");
    expect(host.bootstrap_lifecycle?.drift_count).toBe(0);
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_host_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1776559164732",
      installed: "1776559164732",
    });
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1776560093917",
      installed: "1776560093917",
    });
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_host_bundle",
      )?.message,
    ).toBeUndefined();
    expect(host.bootstrap?.status).toBe("done");
  });

  it("clears a stale bootstrap error once rewritten runtime targets are fully aligned", () => {
    const host = parseRow(
      {
        id: "host-1",
        name: "host-1",
        status: "running",
        version: "1776577465070",
        region: "us-west3",
        metadata: {
          software: {
            project_host: "1776577465070",
            project_bundle: "1776575204948",
            tools: "1775834120905",
          },
          bootstrap: {
            status: "error",
            updated_at: "2026-04-19T05:45:43.935Z",
            message: "bootstrap failed (exit 1) at line 201",
          },
          bootstrap_lifecycle: {
            desired_recorded_at: "2026-04-19T05:45:42.000Z",
            installed_recorded_at: "2026-04-19T05:45:43.000Z",
            last_reconcile_result: "error",
            last_reconcile_started_at: "2026-04-19T05:45:43.000Z",
            last_reconcile_finished_at: "2026-04-19T05:45:43.000Z",
            last_error:
              "download https://lite4b.cocalc.ai/software/project-host/1776559164732/bundle-linux.tar.xz via curl failed with exit code 22",
            summary_status: "error",
            summary_message:
              "download https://lite4b.cocalc.ai/software/project-host/1776559164732/bundle-linux.tar.xz via curl failed with exit code 22",
            drift_count: 0,
            items: [
              {
                key: "project_host_bundle",
                label: "Project host bundle",
                status: "match",
                desired: "1776559164732",
                installed: "1776577465070",
                message: "installed bundle is newer than desired",
              },
              {
                key: "project_bundle",
                label: "Project bundle",
                status: "match",
                desired: "1776575204948",
                installed: "1776575204948",
              },
              {
                key: "tools_bundle",
                label: "Tools bundle",
                status: "match",
                desired: "1775834120905",
                installed: "1775834120905",
              },
            ],
          },
        },
      },
      {
        runtime_desired_artifacts: {
          project_host: "1776577465070",
          project_bundle: "1776575204948",
          tools: "1775834120905",
          updated_at: "2026-04-19T05:47:12.288Z",
        },
      },
    );

    expect(host.bootstrap_lifecycle?.summary_status).toBe("in_sync");
    expect(host.bootstrap_lifecycle?.summary_message).toBe(
      "desired and installed software are aligned",
    );
    expect(host.bootstrap_lifecycle?.drift_count).toBe(0);
    expect(host.bootstrap?.status).toBe("done");
    expect(host.bootstrap?.message).toBe(
      "desired and installed software are aligned",
    );
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_host_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1776577465070",
      installed: "1776577465070",
    });
  });

  it("treats stale build-id and older numeric desired artifacts as aligned with installed runtime versions", () => {
    const host = parseRow(
      {
        id: "host-1",
        name: "host-1",
        status: "running",
        version: "1777603320059",
        region: "us-west3",
        metadata: {
          software: {
            project_host: "1777603320059",
            project_bundle: "1777650485714",
            tools: "1777042500614",
          },
          bootstrap: {
            status: "done",
            updated_at: "2026-05-01T16:32:31.560Z",
            message: "Host software reconciled",
          },
          bootstrap_lifecycle: {
            desired_recorded_at: "2026-05-01T16:32:19.000Z",
            installed_recorded_at: "2026-05-01T16:32:31.000Z",
            summary_status: "drifted",
            summary_message: "2 drift items detected",
            drift_count: 2,
            items: [
              {
                key: "project_host_bundle",
                label: "Project host bundle",
                status: "drift",
                desired: "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
                installed: "1777603320059",
              },
              {
                key: "project_bundle",
                label: "Project bundle",
                status: "drift",
                desired: "1777603336287",
                installed: "1777650485714",
              },
              {
                key: "tools_bundle",
                label: "Tools bundle",
                status: "match",
                desired: "1777042500614",
                installed: "1777042500614",
              },
            ],
          },
        },
      },
      {
        runtime_desired_artifacts: {
          project_host: "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
          project_bundle: "1777603336287",
          tools: "1777042500614",
          updated_at: "2026-05-01T16:32:19.000Z",
        },
      },
    );

    expect(host.bootstrap_lifecycle?.summary_status).toBe("in_sync");
    expect(host.bootstrap_lifecycle?.drift_count).toBe(0);
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_host_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1777603320059",
      installed: "1777603320059",
    });
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1777650485714",
      installed: "1777650485714",
    });
  });

  it("exposes desired and effective pricing separately during standard fallback", () => {
    const host = parseRow({
      id: "host-spot",
      name: "host-spot",
      status: "running",
      region: "us-west1",
      metadata: {
        owner: "acct-1",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "on_demand",
        interruption_restore_policy: "immediate",
        spot_recovery_policy: {
          standard_fallback_enabled: true,
          standard_fallback_min_minutes: 20,
        },
        spot_recovery_state: {
          phase: "running_standard_fallback",
          outage_started_at: "2026-05-03T20:00:00.000Z",
          fallback_started_at: "2026-05-03T20:10:00.000Z",
        },
      },
    });

    expect(host.pricing_model).toBe("spot");
    expect(host.desired_pricing_model).toBe("spot");
    expect(host.effective_pricing_model).toBe("on_demand");
    expect(host.recovery_phase).toBe("running_standard_fallback");
    expect(host.spot_recovery_policy).toMatchObject({
      standard_fallback_enabled: true,
      standard_fallback_min_minutes: 20,
    });
    expect(host.spot_recovery_state).toMatchObject({
      phase: "running_standard_fallback",
      fallback_started_at: "2026-05-03T20:10:00.000Z",
    });
  });
});
