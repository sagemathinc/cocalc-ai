/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { Alert, Card, Radio, Space, Typography } from "antd";

import type { Host } from "@cocalc/conat/hub/api/hosts";
import { Icon } from "@cocalc/frontend/components";
import { SelectNewHost } from "@cocalc/frontend/hosts/select-new-host";
import { useProjectRegion } from "@cocalc/frontend/project/use-project-region";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { R2_REGION_LABELS } from "@cocalc/util/consts";
import type { CourseActions } from "../actions";
import type { CourseSettingsRecord } from "../store";

type PlacementMode = "auto" | "specific";

interface Props {
  actions: CourseActions;
  project_id: string;
  settings: CourseSettingsRecord;
}

export function StudentProjectHostConfig({
  actions,
  project_id,
  settings,
}: Props) {
  const currentHostId =
    `${settings.get("student_project_host_id") ?? ""}`.trim();
  const [placementMode, setPlacementMode] = useState<PlacementMode>(
    currentHostId ? "specific" : "auto",
  );
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const { region } = useProjectRegion(project_id);
  const regionFilter = region ?? undefined;
  const regionLabel = regionFilter
    ? (R2_REGION_LABELS[regionFilter] ?? regionFilter)
    : undefined;

  useEffect(() => {
    setPlacementMode(currentHostId ? "specific" : "auto");
  }, [currentHostId]);

  useEffect(() => {
    let canceled = false;
    async function loadHosts() {
      setLoading(true);
      setError("");
      try {
        const list = await webapp_client.conat_client.hub.hosts.listHosts({
          catalog: true,
        });
        if (!canceled) {
          setHosts(list);
        }
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }
    loadHosts().catch((err) => setError(`${err}`));
    return () => {
      canceled = true;
    };
  }, []);

  const selectedHost = useMemo(
    () => hosts.find((host) => host.id === currentHostId),
    [hosts, currentHostId],
  );

  function setHost(host?: Host) {
    actions.configuration.set_student_project_host({ host_id: host?.id });
    setPlacementMode(host ? "specific" : "auto");
  }

  return (
    <Card
      title={
        <>
          <Icon name="servers" /> Student Project Host
        </>
      }
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Choose where newly created student projects run. Keeping an entire
          course on one dedicated host makes assignment copy operations much
          faster and gives every student access to the same local hardware and
          scratch data.
        </Typography.Paragraph>

        <Radio.Group
          value={placementMode}
          onChange={(e) => {
            const value = e.target.value as PlacementMode;
            setPlacementMode(value);
            if (value === "auto") {
              actions.configuration.set_student_project_host();
            }
          }}
        >
          <Space orientation="vertical">
            <Radio value="auto">
              Select the best available host from the general pool
            </Radio>
            <Radio value="specific">
              Use one specific host for this course
            </Radio>
          </Space>
        </Radio.Group>

        {placementMode === "specific" ? (
          <SelectNewHost
            disabled={loading}
            selectedHost={selectedHost}
            onChange={setHost}
            regionFilter={regionFilter}
            regionLabel={regionLabel}
            pickerMode="create"
            pickerDisplay="modal"
            showHelp
          />
        ) : null}

        {currentHostId && !loading && !selectedHost ? (
          <Alert
            type="warning"
            showIcon
            title="Configured host is no longer visible"
            description={`This course is configured to use host ${currentHostId}, but it was not returned by the host service. Choose another host or switch back to automatic placement.`}
          />
        ) : null}

        {error ? (
          <Alert
            type="error"
            showIcon
            title="Unable to load hosts"
            description={error}
          />
        ) : null}

        <Alert
          type="info"
          showIcon
          title="Existing student projects are not moved automatically"
          description="This setting applies when student projects are created or re-created. Move existing student projects deliberately if you want to consolidate an already-running course."
        />
      </Space>
    </Card>
  );
}
