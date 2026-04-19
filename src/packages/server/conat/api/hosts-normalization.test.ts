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
});
