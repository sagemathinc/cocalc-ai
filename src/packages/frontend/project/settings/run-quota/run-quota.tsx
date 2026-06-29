/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Typography } from "antd";

import { React } from "@cocalc/frontend/app-framework";
import { COLORS } from "@cocalc/util/theme";
import { Project } from "../types";
import { useCurrentUsage, useRunQuota } from "./hooks";

const { Text } = Typography;

interface Props {
  project_id: string;
  project_state?: "opened" | "running" | "starting" | "stopping";
  project: Project;
  mode: "project" | "flyout";
}

export const RunQuota: React.FC<Props> = React.memo(
  (props: Readonly<Props>) => {
    const { project_id, project_state, mode } = props;
    const isFlyout = mode === "flyout";
    const projectIsRunning = project_state === "running";
    const currentUsage = useCurrentUsage({ project_id, shortStr: isFlyout });
    const runQuota = useRunQuota(project_id, null);
    const usage = currentUsage?.memory_limit;
    const limit = runQuota.memory_limit ?? "N/A";

    return (
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "12px",
            marginBottom: "8px",
          }}
        >
          <Text type="secondary">
            {projectIsRunning
              ? "Current memory usage"
              : "Start the project to see current memory usage"}
          </Text>
          <Text
            strong
            style={projectIsRunning ? undefined : { color: COLORS.GRAY_L }}
          >
            Limit: {limit}
          </Text>
        </div>
        {projectIsRunning && usage?.element ? (
          <div>{usage.element}</div>
        ) : (
          <Text type="secondary">Memory usage is not available.</Text>
        )}
        {projectIsRunning && usage?.display ? (
          <div style={{ marginTop: "6px" }}>
            <Text type="secondary">{usage.display}</Text>
          </div>
        ) : null}
      </div>
    );
  },
);
